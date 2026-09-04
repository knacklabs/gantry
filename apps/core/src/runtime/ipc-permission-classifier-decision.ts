import {
  decisionForMode,
  firstPersistentRule,
} from '../domain/permission-decision.js';
import {
  evaluatePermissionDeterministicRails,
  permissionRiskForDeterministicRailDecision,
} from '../domain/permission-deterministic-rails.js';
import {
  PermissionLane,
  RailSignal,
  type RailProvenance,
} from '../domain/permission-lane.js';
import type {
  ConversationRoute,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionRiskLevel,
} from '../domain/types.js';
import {
  resolveEffectivePermissionMode,
  type PermissionMode,
} from '../shared/permission-mode.js';
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
  type PermissionClassifierPromptConsultResult,
} from './permission-classifier.js';
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
  type PermissionDecisionTailContext,
} from './permission-decision-coordinator.js';
import { deriveAutoLaneAnalysis } from '../application/permissions/auto-lane-analysis.js';

type PermissionRuntimeSettings = ReturnType<
  NonNullable<IpcDeps['getPermissionRuntimeSettings']>
>;

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
  const route = resolvePermissionRoute(input);
  const permissionMode = resolveEffectivePermissionMode(
    route?.folder === input.sourceAgentFolder
      ? route.agentConfig?.permissionMode
      : undefined,
    settings?.agents[input.sourceAgentFolder]?.permissionMode,
  );
  const analysis = deriveAutoLaneAnalysis({
    permissionMode,
    hostJobId,
    command: permissionCommand(input.request),
  });
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
  return coordinatePermissionDecision({
    request: input.request,
    effectHash,
    decisionMemory,
    hardDenyReason: protectedCapability
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
    deterministicRails: evaluatePermissionDeterministicRails,
    reviewedRuleDecision: async () => {
      const repository = input.deps.getToolRepository?.();
      if (!repository) return undefined;
      const policy = await resolveAgentToolRuntimePolicy({
        repository,
        appId: input.request.appId ?? 'default',
        agentId:
          input.request.agentId ?? agentIdForFolder(input.sourceAgentFolder),
        errorSubject: 'Configured agent tool',
        skillRepository: input.deps.getSkillRepository?.(),
      }).catch(() => undefined);
      if (!policy) return undefined;
      return new ToolExecutionPolicyService().evaluate({
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
        // Resolve `capability:<id>` rules against the same server-reviewed
        // bundles the rules were projected from — trusted, no new state, and
        // consistent with policy.rules (never runner-supplied definitions).
        semanticCapabilityDefinitions: Object.fromEntries(
          policy.semanticCapabilities.map((capability) => [
            capability.capabilityId,
            capability,
          ]),
        ),
        ...(hostJobId
          ? { autonomousAllowedToolRules: policy.rules }
          : { allowedToolRules: policy.rules }),
      });
    },
    skipClassifierVerdictCache: Boolean(hostJobId),
    analysis,
    tail: (context) =>
      resolvePermissionIpcDecisionTail({
        ...input,
        effectHash,
        decisionMemory,
        hostJobId,
        route,
        settings,
        permissionMode,
        context: context!,
      }),
  });
}

interface PermissionIpcDecisionTailInput {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  effectHash?: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
  hostJobId?: string;
  route?: ConversationRoute;
  settings?: PermissionRuntimeSettings;
  permissionMode: PermissionMode;
  context: PermissionDecisionTailContext;
}

interface IpcClassifierConsultResult {
  decision?: PermissionClassifierPromptConsultResult;
  promotion?: NonNullable<
    Parameters<typeof permissionPromotionHint>[0]['promotion']
  >;
}

interface IpcRailMergeResult {
  railRequiresApproval: boolean;
  railVetoedClassifierAllow: boolean;
  railProvenance?: RailProvenance;
}

function resolvePermissionRoute(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): ConversationRoute | undefined {
  return input.request.targetJid
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
}

function permissionCommand(
  request: ParsedPermissionIpcRequest,
): string | undefined {
  if (request.toolName !== 'Bash' && request.toolName !== 'RunCommand') {
    return undefined;
  }
  const toolInput = request.classifierToolInput ?? request.toolInput;
  const value = toolInput?.command ?? toolInput?.cmd;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function resolvePermissionIpcDecisionTail(
  input: PermissionIpcDecisionTailInput,
): Promise<PermissionApprovalDecision> {
  const routeDecision = applyIpcPermissionRouteGuard(input);
  if (routeDecision) return routeDecision;
  const classifier = await consultIpcPermissionClassifier(input);
  const merge = mergeIpcClassifierWithRail(input, classifier.decision);
  await writeIpcClassifierCache(input, classifier.decision, merge);
  return resolveIpcPermissionPromptOrTerminal(input, classifier, merge);
}

function applyIpcPermissionRouteGuard(
  input: PermissionIpcDecisionTailInput,
): PermissionApprovalDecision | undefined {
  if (input.hostJobId) {
    const railRisk = permissionRiskForDeterministicRailDecision(
      input.context.railDecision,
    );
    // Only trusted host-derived rail risk may ride an autonomous denial into
    // the decision/audit path; without one, strip the worker-supplied fields
    // rather than let an untrusted low/benign claim reach the grant card.
    if (railRisk) {
      input.request.risk_level = railRisk.level;
      if (railRisk.category) {
        input.request.risk_category = railRisk.category;
      } else {
        delete input.request.risk_category;
      }
    } else {
      delete input.request.risk_level;
      delete input.request.risk_category;
    }
    if (!input.route) {
      const reason = `Autonomous permission approval is unavailable: ${input.request.toolName} has no deliverable approver route.`;
      input.request.decisionReason = reason;
      return withRequestRisk(input.request, {
        ...decisionForMode(input.request, 'cancel', 'runtime', 'machine'),
        reason,
      });
    }
  }
  return undefined;
}

async function consultIpcPermissionClassifier(
  input: PermissionIpcDecisionTailInput,
): Promise<IpcClassifierConsultResult> {
  if (input.context.cachedClassifierVerdict) {
    return {
      decision: {
        ...input.context.cachedClassifierVerdict,
        latencyMs: 0,
      },
    };
  }
  const settings = input.settings;
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
  const promotionRepository = input.deps.getPermissionPromotionRepository?.();
  const promotion = promotionRepository
    ? { repository: promotionRepository }
    : undefined;
  const shouldConsultClassifier =
    (input.context.analysis.lane === PermissionLane.InteractiveAuto ||
      input.context.analysis.lane === PermissionLane.AutoStrict) &&
    input.deps.publishRuntimeEvent &&
    classifierConfig;
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
        permissionMode: input.permissionMode,
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
  return { decision: classifierDecision, ...(promotion ? { promotion } : {}) };
}

function mergeIpcClassifierWithRail(
  input: PermissionIpcDecisionTailInput,
  classifierDecision: PermissionClassifierPromptConsultResult | undefined,
): IpcRailMergeResult {
  const railDecision = input.context.railDecision;
  const railAsk =
    railDecision?.railOutcome === 'ask' ? railDecision : undefined;
  const railRequiresApproval = Boolean(
    railAsk &&
    (railAsk.hardFloor === true ||
      railAsk.railSignal === RailSignal.OutOfTrustedRoot ||
      railAsk.railSignal === RailSignal.UnsupportedMetaExecutor),
  );
  const relaxesRailVeto = Boolean(
    classifierDecision?.decision === 'allow' &&
    railAsk &&
    input.context.analysis.lane === PermissionLane.InteractiveAuto &&
    (railAsk.railSignal === RailSignal.OutOfTrustedRoot ||
      (railAsk.railSignal === RailSignal.UnsupportedMetaExecutor &&
        input.context.analysis.readOnlyMetaExecutor)),
  );
  const railVetoedClassifierAllow = Boolean(
    classifierDecision?.decision === 'allow' &&
    railRequiresApproval &&
    !relaxesRailVeto,
  );
  const railProvenance =
    relaxesRailVeto && railAsk
      ? { signal: railAsk.railSignal, reason: railAsk.reason }
      : undefined;
  const primaryRisk = selectPrimaryPermissionRisk(
    permissionRiskForDeterministicRailDecision(railDecision),
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
      ? (railAsk?.reason ??
        'Deterministic permission rail requires human approval.')
      : classifierDecision.reason;
  }
  return {
    railRequiresApproval,
    railVetoedClassifierAllow,
    ...(railProvenance ? { railProvenance } : {}),
  };
}

async function writeIpcClassifierCache(
  input: PermissionIpcDecisionTailInput,
  classifierDecision: PermissionClassifierPromptConsultResult | undefined,
  merge: IpcRailMergeResult,
): Promise<void> {
  // Cache-miss writeback: the tail is reached only on a miss, so a verdict the
  // classifier actually produced is cached here (never a human allow_once —
  // those flow through requestPermissionApproval below and never reach this).
  // Skipped when effectHash is undefined (sanitized/truncated input).
  //
  // A rail ASK marked as requiring approval makes the effect UNCACHEABLE in
  // either direction, not just when it vetoes an allow: its classifier verdict
  // must not be persisted and reused without the same rail context.
  // (subsumes the narrower railVetoedClassifierAllow case: that is an allow
  // under railRequiresApproval, so this guard already covers it.)
  if (
    classifierDecision &&
    !merge.railRequiresApproval &&
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
}

async function resolveIpcPermissionPromptOrTerminal(
  input: PermissionIpcDecisionTailInput,
  classifier: IpcClassifierConsultResult,
  merge: IpcRailMergeResult,
): Promise<PermissionApprovalDecision> {
  const classifierDecision = classifier.decision;
  // Deterministic rails are authoritative: once they require approval, the
  // fallible classifier can downgrade only the two typed interactive-auto
  // read signals whose provenance is preserved on the decision.
  if (
    classifierDecision?.decision === 'allow' &&
    (!merge.railRequiresApproval || merge.railProvenance)
  ) {
    return withRequestRisk(input.request, {
      ...decisionForMode(
        input.request,
        'allow_once',
        'auto_classifier',
        'machine',
      ),
      ...(merge.railProvenance ? { railProvenance: merge.railProvenance } : {}),
    });
  }
  if (
    !input.hostJobId &&
    (input.context.analysis.lane === PermissionLane.InteractiveAuto ||
      input.context.analysis.lane === PermissionLane.AutoStrict) &&
    input.request.unattended
  ) {
    return withRequestRisk(input.request, {
      ...decisionForMode(
        input.request,
        'cancel',
        merge.railVetoedClassifierAllow ? 'deterministic_rails' : 'runtime',
        'machine',
      ),
      reason: merge.railVetoedClassifierAllow
        ? (input.context.railDecision?.reason ??
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
    const result = await input.deps.requestPermissionApproval(input.request);
    if (result.kind === 'delivery_failure') {
      throw new Error(
        `Couldn't deliver the approval prompt: ${result.userMessage}`,
      );
    }
    return withRequestRisk(input.request, result.decision);
  }
  const promotionHint = classifierDecision?.promotionHintCount
    ? {
        promotionHintCount: classifierDecision.promotionHintCount,
        firstAskedAt: classifierDecision.firstAskedAt,
      }
    : await permissionPromotionHint({
        promotion: classifier.promotion,
        appId: input.request.appId,
        agentFolder: input.sourceAgentFolder,
        canonicalToolName: input.request.toolName,
        toolInput: input.request.toolInput,
        suggestions: input.request.suggestions,
      });
  input.request.promotionHintCount = promotionHint?.promotionHintCount;
  input.request.firstAskedAt = promotionHint?.firstAskedAt;
  const effectiveDecisionOptions = input.request.decisionOptions?.length
    ? [...input.request.decisionOptions]
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
  const result = await input.deps.requestPermissionApproval(input.request);
  if (result.kind === 'delivery_failure') {
    throw new Error(
      `Couldn't deliver the approval prompt: ${result.userMessage}`,
    );
  }
  return withRequestRisk(input.request, result.decision);
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
