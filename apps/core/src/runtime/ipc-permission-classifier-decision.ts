import {
  decisionForMode,
  firstPersistentRule,
} from '../domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
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
  permissionPromotionHintCount,
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
  const fixedImageRestricted = input.request.responseKeyId
    ? (permissionRunRestriction({
        sourceAgentFolder: input.sourceAgentFolder,
        responseKeyId: input.request.responseKeyId,
      })?.hideAuthorityTools ?? false)
    : false;
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
            isScheduledJob: Boolean(input.request.jobId),
            jobId: input.request.jobId,
            threadId: input.request.threadId,
            conversationId: input.request.targetJid ?? '',
          },
        ),
        ...(input.request.jobId
          ? { autonomousAllowedToolRules: policy.rules }
          : { allowedToolRules: policy.rules }),
      });
    },
    tail: () =>
      resolvePermissionIpcDecisionTail({
        ...input,
        effectHash,
        decisionMemory,
      }),
  });
}

async function resolvePermissionIpcDecisionTail(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  effectHash?: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
}): Promise<PermissionApprovalDecision> {
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

  // Cache-miss writeback: the tail is reached only on a miss, so a verdict the
  // classifier actually produced is cached here (never a human allow_once —
  // those flow through requestPermissionApproval below and never reach this).
  // Skipped when effectHash is undefined (sanitized/truncated input).
  if (classifierDecision && input.effectHash && input.decisionMemory) {
    await input.decisionMemory
      .putClassifierVerdict({
        appId: input.request.appId ?? 'default',
        agentFolder: input.request.sourceAgentFolder,
        effectHash: input.effectHash,
        decision: classifierDecision.decision,
        reason: classifierDecision.reason,
        effectSchemaVersion: EFFECT_SCHEMA_VERSION,
        railVersion: RAIL_CATALOG_VERSION,
        provenance: 'classifier',
        nowIso: new Date().toISOString(),
      })
      // ponytail: a cache-write failure must never block the live decision.
      .catch(() => undefined);
  }

  if (classifierDecision?.decision === 'allow') {
    return decisionForMode(input.request, 'allow_once', 'auto_classifier');
  }
  if (
    (permissionMode === 'auto' || permissionMode === 'auto_strict') &&
    input.request.unattended
  ) {
    return {
      ...decisionForMode(input.request, 'cancel', 'runtime'),
      reason: classifierDecision
        ? `Classifier requested human approval: ${classifierDecision.reason}`
        : 'This tool is not eligible for unattended auto-permission.',
    };
  }
  if (classifierDecision?.denylistHit) {
    // Denylist-forced prompts are allow-once/cancel only: a persisted rule
    // would never be honored while the denylist blocks rule-based auto-allows.
    input.request.suggestions = undefined;
    input.request.decisionOptions = ['allow_once', 'cancel'];
    return input.deps.requestPermissionApproval(input.request);
  }
  input.request.promotionHintCount =
    classifierDecision?.promotionHintCount ??
    (await permissionPromotionHintCount({
      promotion,
      appId: input.request.appId,
      agentFolder: input.sourceAgentFolder,
      canonicalToolName: input.request.toolName,
      toolInput: input.request.toolInput,
      suggestions: input.request.suggestions,
    }));
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
  return input.deps.requestPermissionApproval(input.request);
}
