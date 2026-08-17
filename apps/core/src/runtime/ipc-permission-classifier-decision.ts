import {
  decisionForMode,
  firstPersistentRule,
} from '../domain/permission-decision.js';
import {
  evaluatePermissionDeterministicRails,
  permissionRiskForDeterministicRailDecision,
  type PermissionDeterministicRailRisk,
} from '../domain/permission-deterministic-rails.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionRiskLevel,
} from '../domain/types.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedPermissionIpcRequest } from './ipc-parsing.js';
import {
  consultPermissionClassifierBeforePrompt,
  permissionPromotionHint,
  recordHumanPermissionPromotionSignal,
} from './permission-classifier.js';
import { runDurablePermissionInteraction } from '../application/interactions/durable-interaction-handler.js';
import { resolveAgentToolRuntimePolicy } from '../application/agents/agent-tool-runtime-rules.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import {
  computePermissionEffectHash,
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../domain/permission-effect-key.js';
import type { PermissionDecisionMemoryRepository } from '../domain/ports/permission-decision-memory.js';
import type { YoloModeSettings } from '../shared/yolo-mode-policy.js';
import {
  evaluateYoloModeDenylist,
  yoloModeDenylistDenyReason,
} from '../shared/yolo-mode-policy.js';
import {
  buildAgentToolExecutionRequest,
  evaluateProtectedCapabilityToolUse,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../shared/tool-execution-policy-service.js';
import {
  coordinatePermissionDecision,
  permissionRunRestriction,
} from './permission-decision-coordinator.js';

export async function resolvePermissionIpcDecision(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<PermissionApprovalDecision> {
  const settings = input.deps.getPermissionRuntimeSettings?.();
  const agentSettings = settings?.agents[input.sourceAgentFolder] as
    | {
        accessPreset?: 'full' | 'locked';
        capabilities?: Array<{ id: string }>;
      }
    | null
    | undefined;
  const approvedCapabilityIds =
    agentSettings?.capabilities?.map(({ id }) => id) ?? [];
  const workspaceRoot = resolveWorkspaceFolderPath(input.sourceAgentFolder);
  const runRestriction = input.request.responseKeyId
    ? permissionRunRestriction({
        sourceAgentFolder: input.sourceAgentFolder,
        responseKeyId: input.request.responseKeyId,
      })
    : undefined;
  const hostJobId = runRestriction?.jobId;
  const fixedImageRestricted = runRestriction?.hideAuthorityTools ?? false;
  // Resolve the agent's reviewed policy before applying the protected-path
  // guard. A skill action intentionally runs a script below the protected
  // skill root; ToolExecutionPolicyService allows it only when the command
  // exactly matches that selected skill action's RunCommand template.
  const repository = input.deps.getToolRepository?.();
  const runtimePolicy = repository
    ? await resolveAgentToolRuntimePolicy({
        repository,
        appId: input.request.appId ?? 'default',
        agentId:
          input.request.agentId ?? agentIdForFolder(input.sourceAgentFolder),
        errorSubject: 'Configured agent tool',
        skillRepository: input.deps.getSkillRepository?.(),
      }).catch(() => undefined)
    : undefined;
  const reviewedToolDecision = runtimePolicy
    ? new ToolExecutionPolicyService().evaluate({
        request: buildAgentToolExecutionRequest(
          new ToolExecutionClassifier(),
          input.request.toolName,
          input.request.toolInput,
          {
            isScheduledJob: Boolean(hostJobId),
            jobId: hostJobId,
            threadId: input.request.threadId,
            conversationId: input.request.targetJid ?? '',
          },
        ),
        semanticCapabilityDefinitions: Object.fromEntries(
          runtimePolicy.semanticCapabilities.map((capability) => [
            capability.capabilityId,
            capability,
          ]),
        ),
        ...(hostJobId
          ? { autonomousAllowedToolRules: runtimePolicy.rules }
          : { allowedToolRules: runtimePolicy.rules }),
      })
    : undefined;
  const protectedCapability = evaluateProtectedCapabilityToolUse(
    input.request.toolName,
    input.request.toolInput,
  );
  const yoloMode = (
    settings?.permissions as { yoloMode?: YoloModeSettings } | undefined
  )?.yoloMode;
  const yoloMatch = evaluateYoloModeDenylist({
    settings: yoloMode,
    toolName: input.request.toolName,
    toolInput: input.request.toolInput,
  });
  const effectHash = computePermissionEffectHash({
    request: input.request,
    workspaceRoot,
  });
  const decisionMemory = input.deps.getPermissionDecisionMemoryRepository?.();
  let railRisk: PermissionDeterministicRailRisk | undefined;
  let railRequiresApproval = false;
  let railApprovalReason: string | undefined;
  return coordinatePermissionDecision({
    request: input.request,
    effectHash,
    decisionMemory,
    hardDenyReason:
      protectedCapability && reviewedToolDecision?.status !== 'allow'
        ? `Denied by Gantry tool execution policy: ${protectedCapability.reason} ${protectedCapability.recoveryAction}`
        : yoloMatch
          ? yoloModeDenylistDenyReason(yoloMatch)
          : undefined,
    accessPreset: agentSettings?.accessPreset,
    fixedImageRestricted,
    deterministicRailsInput: {
      approvedCapabilityIds,
      workspaceRoot,
      trustedRoots: settings?.permissions.trustedRoots ?? [],
    },
    deterministicRails: (railsInput) => {
      const decision = evaluatePermissionDeterministicRails(railsInput);
      if (decision?.railOutcome === 'ask' && decision.hardFloor === true) {
        railRequiresApproval = true;
        railApprovalReason = decision.reason;
      }
      railRisk =
        permissionRiskForDeterministicRailDecision(decision) ?? railRisk;
      return decision;
    },
    reviewedRuleDecision: async () => {
      return reviewedToolDecision;
    },
    skipClassifierVerdictCache: Boolean(hostJobId),
    tail: () =>
      resolvePermissionIpcDecisionTail({
        ...input,
        effectHash,
        decisionMemory,
        railRisk,
        railRequiresApproval,
        railApprovalReason,
        hostJobId,
      }),
  });
}

async function resolvePermissionIpcDecisionTail(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  effectHash?: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
  railRisk?: PermissionDeterministicRailRisk;
  railRequiresApproval?: boolean;
  railApprovalReason?: string;
  hostJobId?: string;
}): Promise<PermissionApprovalDecision> {
  if (input.hostJobId) {
    // Only trusted host-derived rail risk may ride an autonomous denial into
    // the decision/audit path; without one, strip the worker-supplied fields
    // rather than let an untrusted low/benign claim reach the grant card.
    if (input.railRisk) {
      input.request.risk_level = input.railRisk.level;
      if (input.railRisk.category) {
        input.request.risk_category = input.railRisk.category;
      } else {
        delete input.request.risk_category;
      }
    } else {
      delete input.request.risk_level;
      delete input.request.risk_category;
    }
    const reason = `Autonomous runs decide deterministically: ${input.request.toolName} has no declared grant.`;
    input.request.decisionReason = reason;
    return withRequestRisk(input.request, {
      ...decisionForMode(
        input.request,
        'cancel',
        'deterministic_rails',
        'machine',
      ),
      reason,
    });
  }
  const route = input.request.targetJid
    ? findConversationRouteForQueue(
        input.deps.conversationRoutes?.() ?? {},
        makeAgentThreadQueueKey(
          input.request.targetJid,
          agentIdForFolder(input.sourceAgentFolder),
          input.request.threadId,
          input.request.providerAccountId,
        ),
        (candidate) => agentIdForFolder(candidate.folder),
      )
    : undefined;
  const settings = input.deps.getPermissionRuntimeSettings?.();
  const approvedCapabilityIds =
    (
      settings?.agents[input.sourceAgentFolder] as
        | { capabilities?: Array<{ id: string }> }
        | null
        | undefined
    )?.capabilities?.map(({ id }) => id) ?? [];
  const autoModeModel = settings?.permissions.autoMode.model;
  const yoloMode = (
    settings?.permissions as { yoloMode?: YoloModeSettings } | undefined
  )?.yoloMode;
  const classifierConfig = settings
    ? {
        ...(autoModeModel ? { autoModeModel } : {}),
        memoryExtractorModel: settings.memory.llm.models.extractor,
      }
    : undefined;
  const permissionMode = resolveEffectivePermissionMode(
    route?.folder === input.sourceAgentFolder
      ? route.agentConfig?.permissionMode
      : undefined,
    settings?.agents[input.sourceAgentFolder]?.permissionMode,
  );
  const promotionRepository = input.deps.getPermissionPromotionRepository?.();
  const promotion = promotionRepository
    ? {
        repository: promotionRepository,
        offer: async (request: PermissionApprovalRequest) => {
          const interaction = await runDurablePermissionInteraction({
            request,
            sourceAgentFolder: input.sourceAgentFolder,
            prompt: input.deps.requestPermissionApproval,
          });
          if (interaction.resolved)
            recordHumanPermissionPromotionSignal({
              repository: promotionRepository,
              appId: request.appId,
              agentFolder: input.sourceAgentFolder,
              request,
              decision: interaction.decision,
            });
          return interaction;
        },
      }
    : undefined;
  const shouldConsultClassifier =
    input.deps.publishRuntimeEvent &&
    classifierConfig &&
    (permissionMode === 'auto' || permissionMode === 'auto_strict');
  const toolRepository = input.deps.getToolRepository?.();
  const reviewedMcpReadBindings =
    shouldConsultClassifier &&
    toolRepository &&
    /^mcp__(?!gantry__)/.test(input.request.toolName)
      ? ((
          await resolveAgentToolRuntimePolicy({
            repository: toolRepository,
            appId: input.request.appId ?? 'default',
            agentId:
              input.request.agentId ??
              agentIdForFolder(input.sourceAgentFolder),
            errorSubject: 'Configured agent tool',
            skillRepository: input.deps.getSkillRepository?.(),
          }).catch(() => undefined)
        )?.reviewedMcpReadBindings ?? [])
      : [];
  const classifierDecision = shouldConsultClassifier
    ? await consultPermissionClassifierBeforePrompt({
        permissionMode,
        requestFamily: input.request.requestFamily ?? 'tool',
        appId: input.request.appId,
        agentId: input.request.agentId,
        agentFolder: input.sourceAgentFolder,
        // Non-authoritative event metadata only — never a trust input.
        runId: input.request.runId,
        jobId: input.request.jobId,
        conversationId: input.request.targetJid,
        threadId: input.request.threadId,
        correlationId: input.request.requestId,
        actor: 'permission',
        // Host-injected at spawn; best-effort context for the classifier to
        // narrow with — never a trust input.
        intentSource: input.request.turnIntentSummary
          ? 'runner_summary'
          : 'none',
        turnIntentSummary: input.request.turnIntentSummary ?? '',
        canonicalToolName: input.request.toolName,
        toolInput: input.request.classifierToolInput ?? input.request.toolInput,
        toolInputRedactedPaths: input.request.toolInputRedactedPaths,
        toolInputTruncatedPaths: input.request.toolInputTruncatedPaths,
        policyDecisionReason:
          input.request.decisionReason ?? 'Human approval is required.',
        approvedCapabilityIds,
        workspaceRoot: resolveWorkspaceFolderPath(input.sourceAgentFolder),
        reviewedMcpReadBindings,
        yoloMode,
        suggestions: input.request.suggestions,
        ...(promotion ? { promotion } : {}),
        classifierConfig: classifierConfig!,
        publishRuntimeEvent: input.deps.publishRuntimeEvent!,
        classifierConsult: input.deps.classifierConsult,
      })
    : undefined;
  const railVetoedClassifierAllow =
    classifierDecision?.decision === 'allow' && input.railRequiresApproval;
  const primaryRisk = selectPrimaryPermissionRisk(
    input.railRisk,
    classifierDecision
      ? {
          level: classifierDecision.risk_level,
          category: classifierDecision.risk_category,
        }
      : undefined,
  );
  if (primaryRisk) {
    input.request.risk_level = primaryRisk.level;
    if (primaryRisk.category) {
      input.request.risk_category = primaryRisk.category;
    } else {
      delete input.request.risk_category;
    }
  }
  if (classifierDecision) {
    input.request.decisionReason = railVetoedClassifierAllow
      ? (input.railApprovalReason ??
        'Deterministic permission rail requires human approval.')
      : classifierDecision.reason;
  }

  // Cache-miss writeback: the tail is reached only on a miss, so a verdict the
  // classifier actually produced is cached here (never a human allow_once —
  // those flow through requestPermissionApproval below and never reach this).
  // Skipped when effectHash is undefined (sanitized/truncated input).
  //
  // A hard-floor rail ASK makes the effect UNCACHEABLE in either direction, not
  // just when it vetoes an allow: the rail fires precisely when the effect could
  // not be bounded (e.g. a concealed/risk-sanitized input-gated birthright tool),
  // so a verdict derived from input the human never saw must never be persisted
  // and reused by a later concealed request.
  // (subsumes the narrower railVetoedClassifierAllow case: that is an allow
  // under railRequiresApproval, so this guard already covers it.)
  if (
    classifierDecision &&
    !input.railRequiresApproval &&
    input.effectHash &&
    input.decisionMemory
  ) {
    await input.decisionMemory
      .putClassifierVerdict({
        appId: input.request.appId ?? 'default',
        agentFolder: input.request.sourceAgentFolder,
        effectHash: input.effectHash,
        decision: classifierDecision.decision,
        reason: classifierDecision.reason,
        risk_level: classifierDecision.risk_level,
        risk_category: classifierDecision.risk_category,
        effectSchemaVersion: EFFECT_SCHEMA_VERSION,
        railVersion: RAIL_CATALOG_VERSION,
        provenance: 'classifier',
        nowIso: new Date().toISOString(),
      })
      // ponytail: a cache-write failure must never block the live decision.
      .catch(() => undefined);
  }

  // Deterministic rails are authoritative: once they require approval, the
  // fallible classifier cannot downgrade that ASK. Classifier auto-allow is
  // available only when the rails abstain.
  if (classifierDecision?.decision === 'allow' && !input.railRequiresApproval) {
    return withRequestRisk(
      input.request,
      decisionForMode(
        input.request,
        'allow_once',
        'auto_classifier',
        'machine',
      ),
    );
  }
  if (
    (permissionMode === 'auto' || permissionMode === 'auto_strict') &&
    input.request.unattended
  ) {
    return withRequestRisk(input.request, {
      ...decisionForMode(
        input.request,
        'cancel',
        railVetoedClassifierAllow ? 'deterministic_rails' : 'runtime',
        'machine',
      ),
      reason: railVetoedClassifierAllow
        ? (input.railApprovalReason ??
          'Deterministic permission rail requires human approval.')
        : classifierDecision
          ? `Classifier requested human approval: ${classifierDecision.reason}`
          : 'This tool is not eligible for unattended auto-permission.',
    });
  }
  if (classifierDecision?.denylistHit) {
    // Denylist-forced prompts are allow-once/cancel only: a persisted rule
    // would never be honored while the denylist blocks rule-based auto-allows.
    input.request.suggestions = undefined;
    input.request.decisionOptions = ['allow_once', 'cancel'];
    return withRequestRisk(
      input.request,
      await input.deps.requestPermissionApproval(input.request),
    );
  }
  const promotionHint = classifierDecision?.promotionHintCount
    ? {
        promotionHintCount: classifierDecision.promotionHintCount,
        firstAskedAt: classifierDecision.firstAskedAt,
      }
    : await permissionPromotionHint({
        promotion,
        appId: input.request.appId,
        agentFolder: input.sourceAgentFolder,
        canonicalToolName: input.request.toolName,
        toolInput: input.request.toolInput,
        suggestions: input.request.suggestions,
      });
  input.request.promotionHintCount = promotionHint?.promotionHintCount;
  input.request.firstAskedAt = promotionHint?.firstAskedAt;
  const effectiveDecisionOptions = input.request.decisionOptions?.length
    ? input.request.decisionOptions
    : firstPersistentRule(input.request)
      ? ['allow_once', 'allow_persistent_rule', 'cancel']
      : ['allow_once', 'cancel'];
  if (
    input.request.promotionHintCount &&
    effectiveDecisionOptions.includes('allow_persistent_rule')
  ) {
    input.request.decisionOptions = [
      'allow_persistent_rule',
      'allow_once',
      'cancel',
    ];
  }
  return withRequestRisk(
    input.request,
    await input.deps.requestPermissionApproval(input.request),
  );
}

function withRequestRisk(
  request: PermissionApprovalRequest,
  decision: PermissionApprovalDecision,
): PermissionApprovalDecision {
  return {
    ...decision,
    ...(request.risk_level ? { risk_level: request.risk_level } : {}),
    ...(request.risk_category ? { risk_category: request.risk_category } : {}),
  };
}

const PERMISSION_RISK_SEVERITY_RANK: Record<PermissionRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

type PermissionRiskSignal = {
  level: PermissionRiskLevel;
  category?: PermissionApprovalRequest['risk_category'];
};

function selectPrimaryPermissionRisk(
  railRisk: PermissionRiskSignal | undefined,
  classifierRisk: PermissionRiskSignal | undefined,
): PermissionRiskSignal | undefined {
  if (!railRisk) return classifierRisk;
  if (!classifierRisk) return railRisk;
  if (
    PERMISSION_RISK_SEVERITY_RANK[classifierRisk.level] <=
    PERMISSION_RISK_SEVERITY_RANK[railRisk.level]
  ) {
    return railRisk;
  }
  return classifierRisk.category && classifierRisk.category !== 'benign'
    ? classifierRisk
    : { ...railRisk, level: classifierRisk.level };
}
