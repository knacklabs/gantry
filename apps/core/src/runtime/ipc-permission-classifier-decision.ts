import { firstPersistentRule } from '../domain/permission-decision.js';
import { evaluatePermissionDeterministicRails } from '../domain/permission-deterministic-rails.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import {
  resolveEffectivePermissionMode,
  type PermissionMode,
} from '../shared/permission-mode.js';
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
import { computePermissionEffectHash } from '../domain/permission-effect-key.js';
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
  findPermissionRoute,
  missingPermissionRouteReason,
  permissionRunRestriction,
  type PermissionDecisionTailContext,
} from './permission-decision-coordinator.js';
import { deriveAutoLaneAnalysis } from '../application/permissions/auto-lane-analysis.js';
import type { AutoLaneAnalysis } from '../application/permissions/auto-lane-analysis-types.js';
import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
import type { PermissionRememberPromptFacts } from '../application/permissions/human-decision-learning.js';
import { resolveIpcPermissionJobProjection } from './ipc-permission-job-projection.js';

type PermissionRuntimeSettings = ReturnType<
  NonNullable<IpcDeps['getPermissionRuntimeSettings']>
>;
type PermissionDecisionIpcDeps = Omit<IpcDeps, 'requestPermissionApproval'> & {
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
    facts?: PermissionRememberPromptFacts,
  ) => ReturnType<IpcDeps['requestPermissionApproval']>;
};

export async function resolvePermissionIpcDecision(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: PermissionDecisionIpcDeps;
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
  const route = findPermissionRoute({
    routes: input.deps.conversationRoutes?.() ?? {},
    targetJid: input.request.targetJid,
    agentId: agentIdForFolder(input.sourceAgentFolder),
    threadId: input.request.threadId,
    providerAccountId: input.request.providerAccountId,
  });
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
  const humanDecisionProjection = await resolveIpcPermissionJobProjection({
    hostJobId,
    deps: input.deps,
  });
  const ipcInput: PermissionIpcInput = {
    ...input,
    effectHash,
    hostJobId,
    workspaceRoot,
    settings,
    permissionMode,
    analysis,
  };
  return coordinatePermissionDecision({
    request: input.request,
    routeRefusal: () =>
      route ? undefined : missingPermissionRouteReason(input.request.toolName),
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
    skipClassifierVerdictCache: Boolean(
      gantryNativeCanonicalToolName(input.request.toolName)?.canonical ===
      'capability_run',
    ),
    analysis,
    ...(humanDecisionProjection ? { humanDecisionProjection } : {}),
    // Jobs follow their agent's mode, like chat: `ask` asks a person.
    ...(permissionMode !== 'ask'
      ? { consultClassifier: () => consultIpcPermissionClassifier(ipcInput) }
      : {}),
    tail: (context) => promptIpcPermission(ipcInput, context),
  });
}

interface PermissionIpcInput {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: PermissionDecisionIpcDeps;
  effectHash?: string;
  hostJobId?: string;
  workspaceRoot: string;
  settings?: PermissionRuntimeSettings;
  permissionMode: PermissionMode;
  analysis: AutoLaneAnalysis;
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

async function consultIpcPermissionClassifier(
  input: PermissionIpcInput,
): Promise<PermissionClassifierPromptConsultResult | undefined> {
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
  const toolRepository = input.deps.getToolRepository?.();
  const reviewedMcpReadBindings =
    toolRepository && /^mcp__(?!gantry__)/.test(input.request.toolName)
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
  return consultPermissionClassifierBeforePrompt({
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
    actor: { kind: 'system', source: 'permission' },
    // Host-injected at spawn; best-effort context for the classifier to
    // narrow with — never a trust input.
    intentSource: input.request.turnIntentSummary ? 'runner_summary' : 'none',
    turnIntentSummary: input.request.turnIntentSummary ?? '',
    canonicalToolName: input.request.toolName,
    toolInput: input.request.classifierToolInput ?? input.request.toolInput,
    toolInputRedactedPaths: input.request.toolInputRedactedPaths,
    toolInputTruncatedPaths: input.request.toolInputTruncatedPaths,
    policyDecisionReason:
      input.request.decisionReason ?? 'Human approval is required.',
    approvedCapabilityIds,
    workspaceRoot: input.workspaceRoot,
    lane: input.analysis.lane,
    reviewedMcpReadBindings,
    yoloMode,
    suggestions: input.request.suggestions,
    ...(promotionRepository
      ? { promotion: { repository: promotionRepository } }
      : {}),
    classifierConfig,
    publishRuntimeEvent: input.deps.publishRuntimeEvent,
    classifierConsult: input.deps.classifierConsult,
  });
}

/** The IPC ask: the prompt in the conversation, or the job's waiting record. */
async function promptIpcPermission(
  input: PermissionIpcInput,
  context: PermissionDecisionTailContext,
): Promise<PermissionApprovalDecision> {
  const { request } = input;
  const classifierDecision = context.classifierDecision;
  if (!classifierDecision?.denylistHit) {
    const promotionRepository = input.deps.getPermissionPromotionRepository?.();
    const promotionHint = classifierDecision?.promotionHintCount
      ? {
          promotionHintCount: classifierDecision.promotionHintCount,
          firstAskedAt: classifierDecision.firstAskedAt,
        }
      : await permissionPromotionHint({
          promotion: promotionRepository
            ? { repository: promotionRepository }
            : undefined,
          appId: request.appId,
          agentFolder: input.sourceAgentFolder,
          canonicalToolName: request.toolName,
          toolInput: request.toolInput,
          suggestions: request.suggestions,
        });
    request.promotionHintCount = promotionHint?.promotionHintCount;
    request.firstAskedAt = promotionHint?.firstAskedAt;
    const effectiveDecisionOptions = request.decisionOptions?.length
      ? [...request.decisionOptions]
      : firstPersistentRule(request)
        ? ['allow_once', 'allow_persistent_rule', 'cancel']
        : ['allow_once', 'cancel'];
    if (
      request.promotionHintCount &&
      effectiveDecisionOptions.includes('allow_persistent_rule')
    ) {
      request.decisionOptions = [
        'allow_persistent_rule',
        'allow_once',
        'cancel',
      ];
    }
  }
  const result = await input.deps.requestPermissionApproval(request, {
    analysis: input.analysis,
    effectHash: input.effectHash,
    workspaceRoot: input.workspaceRoot,
    canonicalRoot: context.canonicalRoot,
  });
  if (result.kind === 'delivery_failure') {
    throw new Error(
      `Couldn't deliver the approval prompt: ${result.userMessage}`,
    );
  }
  return {
    ...result.decision,
    ...(request.risk_level ? { risk_level: request.risk_level } : {}),
    ...(request.risk_category ? { risk_category: request.risk_category } : {}),
  };
}
