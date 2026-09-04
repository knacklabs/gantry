import type { AppId } from '../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import {
  isPermissionClassifierEligible,
  type PermissionClassifierRequestFamily,
} from '../application/permissions/permission-classifier.js';
import { PermissionClassifierStatus } from '../domain/permission-classifier-status.js';
import {
  PERMISSION_PROMOTION_ALLOW_THRESHOLD,
  type PermissionPromotionInput,
} from '../application/permissions/permission-promotion.js';
import {
  permissionSuggestionKey,
  synthesizeHostPermissionSuggestions,
} from '../application/permissions/permission-suggestion-synthesis.js';
import type {
  MemoryLlmClient,
  MemoryLlmModelProfile,
} from '../domain/ports/memory-llm-client.js';
import type { PermissionPromotionRepository } from '../domain/ports/permission-promotion.js';
import { logger } from '../infrastructure/logging/logger.js';
import { getMemoryLlmClient } from '../memory/memory-llm-port.js';
import { evaluateAutoPermissionReadOnlyGate } from '../shared/auto-permission-read-only-gate.js';
import type { McpReadBinding } from '../shared/auto-permission-read-only-gate.js';
import {
  isMemoryOperationTimeoutError,
  runWithMemoryOperationTimeout,
} from '../shared/memory-dreaming-timeout.js';
import { resolveModelSelectionForWorkload } from '../shared/model-catalog.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import * as yolo from '../shared/yolo-mode-policy.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
  PermissionRiskCategory,
} from '../domain/types.js';
import {
  classifierUserPayload,
  parsePermissionClassifierResponse,
  permissionClassifierSystemPrompt,
  serializePermissionClassifierToolInput,
  type PermissionClassifierRiskLevel,
} from './permission-classifier-prompt.js';
import { evaluateNativeRiskBranch } from './permission-classifier-native-risk.js';
import { coordinatePermissionClassifierRisk } from './permission-decision-coordinator.js';

export {
  PERMISSION_CLASSIFIER_MAX_STRING_LENGTH,
  PERMISSION_CLASSIFIER_MAX_TOOL_INPUT_CHARS,
  redactPermissionClassifierToolInput,
  serializePermissionClassifierToolInput,
} from './permission-classifier-prompt.js';

export const PERMISSION_CLASSIFIER_TIMEOUT_MS = 12_000;
const RECENT_PERMISSION_SIGNAL_MS = 7 * 24 * 60 * 60 * 1_000;

export type PermissionClassifierFailureCode =
  | 'llm_unconfigured'
  | 'timeout'
  | 'aborted'
  | 'model_resolution_failure'
  | 'query_error'
  | 'parse_failure'
  | 'validation_failure'
  | 'input_truncated';

export interface PermissionClassifierInput {
  appId: AppId;
  agentIdentity: {
    id: string;
    name?: string;
    folder?: string;
  };
  turnIntentSummary: string;
  canonicalToolName: string;
  toolInput: unknown;
  policyDecisionReason: string;
  approvedCapabilityIds: string[];
  recentlyApprovedExactToolShape?: boolean;
  recentlyDeniedExactToolShape?: boolean;
  autoModeModel?: string;
  memoryModelConfig: {
    extractor: string;
    modelProfiles?: {
      extractor?: MemoryLlmModelProfile;
    };
  };
  signal?: AbortSignal;
}

export interface PermissionClassifierResult {
  /** TODO(T6): publish and consume classifier availability after T2a stamps it. */
  status: PermissionClassifierStatus;
  risk_level: PermissionClassifierRiskLevel;
  risk_category?: PermissionRiskCategory;
  reason: string;
  latencyMs: number;
  model?: string;
  failureCode?: PermissionClassifierFailureCode;
}

export interface PublishPermissionClassifierDecisionInput {
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  appId: RuntimeEventPublishInput['appId'];
  agentId: RuntimeEventPublishInput['agentId'];
  runId: RuntimeEventPublishInput['runId'];
  jobId?: NonNullable<RuntimeEventPublishInput['jobId']>;
  conversationId?: NonNullable<RuntimeEventPublishInput['conversationId']>;
  threadId?: NonNullable<RuntimeEventPublishInput['threadId']>;
  correlationId?: NonNullable<RuntimeEventPublishInput['correlationId']>;
  actor: RuntimeEventPublishInput['actor'];
  intentSource: PermissionClassifierIntentSource;
  toolName: string;
  decision: PermissionClassifierPromptConsultResult['decision'];
  risk_level: PermissionClassifierRiskLevel;
  reason: string;
  latencyMs: number;
  model?: string;
  failureCode?: PermissionClassifierFailureCode;
  suggestionKey?: string;
}

export type PermissionClassifierIntentSource =
  | 'operator_message'
  | 'runner_summary'
  | 'none';
export interface PermissionClassifierPromptConsultInput {
  permissionMode: PermissionMode;
  requestFamily: PermissionClassifierRequestFamily;
  appId?: string;
  agentId?: string;
  agentName?: string;
  agentFolder: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string;
  correlationId: string;
  actor: RuntimeEventPublishInput['actor'];
  intentSource: PermissionClassifierIntentSource;
  turnIntentSummary: string;
  canonicalToolName: string;
  toolInput: unknown;
  toolInputRedactedPaths?: string[];
  toolInputTruncatedPaths?: string[];
  policyDecisionReason: string;
  approvedCapabilityIds: string[];
  workspaceRoot?: string;
  reviewedMcpReadBindings?: McpReadBinding[];
  yoloMode?: yolo.YoloModeSettings;
  suggestions?: PermissionApprovalUpdate[];
  promotion?: Pick<PermissionPromotionInput, 'repository'>;
  classifierConfig: PermissionClassifierRuntimeConfig;
  signal?: AbortSignal;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  classifierConsult?: typeof consultPermissionClassifier;
}
export interface PermissionClassifierPromptConsultResult extends PermissionClassifierResult {
  decision: 'allow' | 'ask';
  suggestions?: PermissionApprovalUpdate[];
  suggestionKey?: string;
  promotionHintCount?: number;
  firstAskedAt?: string;
  /** Set when the YOLO denylist forced this ask — callers must not offer
   * persistent grants the denylist would never honor. */
  denylistHit?: true;
}

export interface PermissionClassifierRuntimeConfig {
  autoModeModel?: string;
  memoryExtractorModel: string;
}

export async function consultPermissionClassifier(
  input: PermissionClassifierInput,
): Promise<PermissionClassifierResult> {
  const startedAt = Date.now();
  let llm: MemoryLlmClient;
  try {
    llm = getMemoryLlmClient();
    if (!llm.isConfigured()) {
      return failedResult('llm_unconfigured', startedAt);
    }
  } catch (error) {
    return failedResult('llm_unconfigured', startedAt, error);
  }

  let modelSelection: {
    model: string;
    modelProfile?: MemoryLlmModelProfile;
  };
  try {
    modelSelection = resolveClassifierModel(input);
  } catch (error) {
    return failedResult('model_resolution_failure', startedAt, error);
  }

  let response: string;
  try {
    response = await runWithMemoryOperationTimeout(
      (signal) => {
        const query = {
          appId: input.appId,
          model: modelSelection.model,
          ...(modelSelection.modelProfile
            ? { modelProfile: modelSelection.modelProfile }
            : {}),
          systemPrompt: permissionClassifierSystemPrompt(),
          prompt: classifierUserPayload(input),
          signal,
          timeoutMs: PERMISSION_CLASSIFIER_TIMEOUT_MS,
          singleRequest: true,
        };
        return llm.query(query);
      },
      {
        timeoutMs: PERMISSION_CLASSIFIER_TIMEOUT_MS,
        label: 'permission classifier',
        parentSignal: input.signal,
      },
    );
  } catch (error) {
    const failureCode = isClassifierTimeoutError(error)
      ? 'timeout'
      : input.signal?.aborted || isAbortError(error)
        ? 'aborted'
        : 'query_error';
    return failedResult(failureCode, startedAt, error, modelSelection.model);
  }

  const verdict = parsePermissionClassifierResponse(response);
  if (!verdict.ok) {
    return failedResult(
      verdict.failureCode,
      startedAt,
      verdict.error,
      modelSelection.model,
    );
  }

  return {
    status: PermissionClassifierStatus.Answered,
    risk_level: verdict.risk_level,
    ...(verdict.risk_category ? { risk_category: verdict.risk_category } : {}),
    reason: verdict.reason,
    latencyMs: Date.now() - startedAt,
    model: modelSelection.model,
  };
}

export async function consultPermissionClassifierBeforePrompt(
  input: PermissionClassifierPromptConsultInput,
): Promise<PermissionClassifierPromptConsultResult | undefined> {
  if (
    (input.permissionMode !== 'auto' &&
      input.permissionMode !== 'auto_strict') ||
    !isPermissionClassifierEligible(
      input.canonicalToolName,
      input.requestFamily,
    )
  ) {
    return undefined;
  }
  const suggestions =
    input.suggestions ??
    synthesizeHostPermissionSuggestions(
      input.canonicalToolName,
      input.toolInput,
    );
  // Promotion history is deliberately per agent + tool shape. Reusing it
  // across jobs lets repeated one-time approvals escalate consistently while
  // preserving each agent's independent authority boundary.
  const suggestionKey = permissionSuggestionKey(input.agentFolder, suggestions);
  // prettier-ignore
  const promotionCounter = await readPromotionCounter({ promotion: input.promotion, appId: input.appId ?? 'default', agentFolder: input.agentFolder, suggestionKey });
  // prettier-ignore
  const shellRequest = input.canonicalToolName === 'Bash' || input.canonicalToolName === 'RunCommand';
  const shellInput = input.toolInput as {
    command?: unknown;
    cmd?: unknown;
  } | null;
  // Prefer whichever command field is a usable string — a non-string
  // `command` must not mask a real `cmd` alias.
  const shellCommandField =
    typeof shellInput?.command === 'string'
      ? shellInput.command
      : shellInput?.cmd;
  const classifierToolInput = shellRequest
    ? {
        command: shellCommandField,
      }
    : input.toolInput;
  const incompletePaths = [
    ...(input.toolInputRedactedPaths ?? []),
    ...(input.toolInputTruncatedPaths ?? []),
  ];
  const pathTruncated = shellRequest
    ? incompletePaths.some((path) => path === 'command' || path === 'cmd')
    : incompletePaths.length > 0;
  const inputTruncated =
    pathTruncated ||
    serializePermissionClassifierToolInput(classifierToolInput).truncated;
  // The denylist must judge the same normalized command the gate and
  // classifier see — host-injected env prefixes must not mask a match.
  // prettier-ignore
  const yoloDenylistMatch = yolo.evaluateYoloModeDenylist({ settings: input.yoloMode, toolName: input.canonicalToolName, toolInput: classifierToolInput });
  const deterministicGate =
    inputTruncated || yoloDenylistMatch
      ? undefined
      : evaluateAutoPermissionReadOnlyGate({
          canonicalToolName: input.canonicalToolName,
          toolInput: classifierToolInput,
          approvedCapabilityIds: input.approvedCapabilityIds,
          workspaceRoot: input.workspaceRoot,
          reviewedMcpReadBindings: input.reviewedMcpReadBindings,
        });
  // Gantry-native tools get a deterministic, config-free default risk rating
  // instead of an LLM call: routine reads/mutations rate low/medium (auto), and
  // authority/destructive/unknown tools rate high (ask). The truncated-input and
  // YOLO-denylist safety gates above still win. Non-gantry tools return
  // undefined here and keep the Bash / third-party-MCP / LLM path unchanged.
  //
  // Gated on the 'tool' family ONLY: this map rates tool EXECUTION risk. A
  // tool's routine execution rating does NOT establish that granting durable
  // authority (promotion) or approving a review is safe. isPermissionClassifier-
  // Eligible already blocks non-'tool' families at the top of this function, so
  // this is defense-in-depth: the gantry map can never auto-allow a non-'tool'
  // request even if that eligibility gate is later broadened.
  const nativeRisk = evaluateNativeRiskBranch({
    canonicalToolName: input.canonicalToolName,
    inputTruncated,
    yoloDenylistHit: Boolean(yoloDenylistMatch),
    requestFamily: input.requestFamily,
  });
  const classifierResult: PermissionClassifierResult = inputTruncated
    ? {
        status: PermissionClassifierStatus.Skipped,
        risk_level: 'high',
        reason:
          'Classifier skipped because its tool input view was incomplete; ask the user.',
        latencyMs: 0,
        failureCode: 'input_truncated',
      }
    : // prettier-ignore
      yoloDenylistMatch ? { status: PermissionClassifierStatus.Skipped, risk_level: 'high', reason: `YOLO-mode denylist backstop matched "${yoloDenylistMatch.pattern}"; ask the user for explicit approval.`, latencyMs: 0 }
      : // The auto_strict deterministic-denial guard runs BEFORE the gantry
        // verdict: the gantry map may only REDUCE prompts in normal auto mode,
        // never turn a strict-mode denial into an allow. In auto_strict a gantry
        // mutation (gate not allowed) still asks; gantry reads never reach here
        // (rails birthright-allow them first).
        !deterministicGate?.allowed && input.permissionMode === 'auto_strict'
          ? {
              status: PermissionClassifierStatus.Skipped,
              risk_level: 'high',
              reason:
                deterministicGate?.reason ??
                'Deterministic read-only proof was unavailable; ask the user.',
              latencyMs: 0,
            }
      : nativeRisk
          ? nativeRisk
          : await (input.classifierConsult ?? consultPermissionClassifier)({
            appId: (input.appId ?? 'default') as AppId,
            agentIdentity: {
              id: input.agentId ?? input.agentFolder,
              ...(input.agentName ? { name: input.agentName } : {}),
              folder: input.agentFolder,
            },
            turnIntentSummary: input.turnIntentSummary,
            canonicalToolName: input.canonicalToolName,
            toolInput: classifierToolInput,
            policyDecisionReason: input.policyDecisionReason,
            approvedCapabilityIds: input.approvedCapabilityIds,
            recentlyApprovedExactToolShape:
              wasRecentlyApproved(promotionCounter),
            recentlyDeniedExactToolShape: wasRecentlyDenied(promotionCounter),
            autoModeModel: input.classifierConfig.autoModeModel,
            memoryModelConfig: {
              extractor: input.classifierConfig.memoryExtractorModel,
            },
            signal: input.signal,
          });
  const result: PermissionClassifierPromptConsultResult = {
    ...classifierResult,
    decision: await coordinatePermissionClassifierRisk({
      riskLevel: classifierResult.risk_level,
      allow: () => 'allow' as const,
      tail: async () => 'ask' as const,
    }),
  };
  if (yoloDenylistMatch && !inputTruncated) {
    // Contract: every denylist backstop match emits the dedicated audit
    // event, matching the SDK gate's emitYoloDenylistHit payload shape.
    await input
      .publishRuntimeEvent({
        appId: (input.appId ?? 'default') as never,
        agentId: input.agentId as never,
        runId: input.runId as never,
        jobId: input.jobId as never,
        conversationId: input.conversationId as never,
        threadId: input.threadId as never,
        correlationId: input.correlationId as never,
        eventType: RUNTIME_EVENT_TYPES.PERMISSION_YOLO_DENYLIST_HIT,
        actor: input.actor,
        payload: {
          decision: 'yolo_denylist_hit',
          matchedPattern: yoloDenylistMatch.pattern,
          matchKind: yoloDenylistMatch.kind,
          tool: yoloDenylistMatch.toolName,
          reason: result.reason,
        },
      })
      .catch((error) => {
        logger.warn(
          { err: error, toolName: input.canonicalToolName },
          'Failed to publish YOLO denylist hit event',
        );
      });
  }
  await publishPermissionClassifierDecision({
    publishRuntimeEvent: input.publishRuntimeEvent,
    appId: (input.appId ?? 'default') as never,
    agentId: input.agentId as never,
    runId: input.runId as never,
    jobId: input.jobId as never,
    conversationId: input.conversationId as never,
    threadId: input.threadId as never,
    correlationId: input.correlationId as never,
    actor: input.actor,
    intentSource: input.intentSource,
    toolName: input.canonicalToolName,
    ...(suggestionKey ? { suggestionKey } : {}),
    ...result,
  });
  // A denylist hit must not carry persistent suggestions: a saved rule would
  // never be honored while the denylist keeps blocking rule-based auto-allows.
  const denylistHit = Boolean(yoloDenylistMatch) && !inputTruncated;
  return {
    ...result,
    ...(denylistHit ? { denylistHit: true as const } : {}),
    ...(suggestions && !denylistHit ? { suggestions } : {}),
    ...(suggestionKey ? { suggestionKey } : {}),
    ...(promotionCounter &&
    !denylistHit &&
    promotionCounter.allowCount >= PERMISSION_PROMOTION_ALLOW_THRESHOLD
      ? {
          promotionHintCount: promotionCounter.allowCount,
          firstAskedAt: promotionCounter.createdAt,
        }
      : {}),
  };
}

export async function permissionPromotionHint(input: {
  promotion?: PermissionClassifierPromptConsultInput['promotion'];
  appId?: string;
  agentFolder: string;
  canonicalToolName: string;
  toolInput: unknown;
  suggestions?: PermissionApprovalUpdate[];
}): Promise<{ promotionHintCount: number; firstAskedAt: string } | undefined> {
  const suggestions =
    input.suggestions ??
    synthesizeHostPermissionSuggestions(
      input.canonicalToolName,
      input.toolInput,
    );
  const counter = await readPromotionCounter({
    promotion: input.promotion,
    appId: input.appId ?? 'default',
    agentFolder: input.agentFolder,
    suggestionKey: permissionSuggestionKey(input.agentFolder, suggestions),
  });
  return counter && counter.allowCount >= PERMISSION_PROMOTION_ALLOW_THRESHOLD
    ? {
        promotionHintCount: counter.allowCount,
        firstAskedAt: counter.createdAt,
      }
    : undefined;
}

export async function permissionPromotionHintCount(
  input: Parameters<typeof permissionPromotionHint>[0],
): Promise<number | undefined> {
  return (await permissionPromotionHint(input))?.promotionHintCount;
}

export function recordHumanPermissionPromotionSignal(input: {
  repository?: PermissionPromotionRepository;
  appId?: string;
  agentFolder: string;
  request: PermissionApprovalRequest;
  decision: PermissionApprovalDecision;
}): void {
  if (!input.repository || !isHumanPermissionDecision(input.decision)) return;
  const suggestionKey = permissionSuggestionKey(
    input.agentFolder,
    input.request.suggestions,
  );
  if (!suggestionKey) return;
  const nowIso = new Date().toISOString();
  const operation =
    input.decision.approved && input.decision.mode === 'allow_once'
      ? input.repository.incrementAndGet({
          appId: input.appId ?? 'default',
          agentFolder: input.agentFolder,
          suggestionKey,
          nowIso,
        })
      : input.decision.mode === 'cancel' ||
          input.decision.decisionClassification === 'user_reject'
        ? input.repository.markDenied({
            appId: input.appId ?? 'default',
            agentFolder: input.agentFolder,
            suggestionKey,
            nowIso,
          })
        : undefined;
  void operation?.catch((error) =>
    logger.warn(
      {
        error,
        appId: input.appId,
        agentFolder: input.agentFolder,
        suggestionKey,
      },
      'Permission promotion decision signal failed',
    ),
  );
}

function isHumanPermissionDecision(
  decision: PermissionApprovalDecision,
): boolean {
  const decidedBy = decision.decidedBy?.trim().toLowerCase();
  return Boolean(
    decidedBy && !['auto_classifier', 'runtime', 'system'].includes(decidedBy),
  );
}

async function readPromotionCounter(input: {
  promotion?: PermissionClassifierPromptConsultInput['promotion'];
  appId: string;
  agentFolder: string;
  suggestionKey?: string;
}) {
  if (!input.promotion || !input.suggestionKey) return null;
  try {
    return await input.promotion.repository.get({
      appId: input.appId,
      agentFolder: input.agentFolder,
      suggestionKey: input.suggestionKey,
    });
  } catch (error) {
    logger.warn(
      { error, appId: input.appId, agentFolder: input.agentFolder },
      'Permission promotion context read failed',
    );
    return null;
  }
}

function wasRecentlyDenied(
  counter: Awaited<ReturnType<typeof readPromotionCounter>>,
): boolean {
  if (!counter?.deniedAt) return false;
  const deniedAtMs = Date.parse(counter.deniedAt);
  return (
    Number.isFinite(deniedAtMs) &&
    deniedAtMs >= Date.now() - RECENT_PERMISSION_SIGNAL_MS
  );
}

function wasRecentlyApproved(
  counter: Awaited<ReturnType<typeof readPromotionCounter>>,
): boolean {
  if (
    !counter ||
    counter.allowCount < PERMISSION_PROMOTION_ALLOW_THRESHOLD ||
    wasRecentlyDenied(counter)
  ) {
    return false;
  }
  const approvedAtMs = Date.parse(counter.updatedAt);
  return (
    Number.isFinite(approvedAtMs) &&
    approvedAtMs >= Date.now() - RECENT_PERMISSION_SIGNAL_MS
  );
}

function resolveClassifierModel(input: PermissionClassifierInput): {
  model: string;
  modelProfile?: MemoryLlmModelProfile;
} {
  const resolved = resolveModelSelectionForWorkload(
    input.autoModeModel?.trim() || input.memoryModelConfig.extractor,
    'memory_extractor',
  );
  if (!resolved.ok) throw new Error(resolved.message);
  return {
    model: resolved.runnerModel,
    modelProfile: {
      alias: resolved.entry.recommendedAlias,
      runnerModel: resolved.entry.runnerModel,
      responseFamily: resolved.entry.responseFamily,
      modelRoute: resolved.entry.modelRoute.id,
      modelRouteLabel: resolved.entry.modelRoute.label,
      displayName: resolved.entry.displayName,
    },
  };
}

export async function publishPermissionClassifierDecision(
  input: PublishPermissionClassifierDecisionInput,
): Promise<void> {
  await input.publishRuntimeEvent({
    appId: input.appId,
    agentId: input.agentId,
    runId: input.runId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : {}),
    eventType: RUNTIME_EVENT_TYPES.PERMISSION_CLASSIFIER_DECISION,
    actor: input.actor,
    payload: {
      toolName: input.toolName,
      intentSource: input.intentSource,
      decision: input.decision,
      riskLevel: input.risk_level,
      reason: input.reason,
      latencyMs: input.latencyMs,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.failureCode !== undefined
        ? { failureCode: input.failureCode }
        : {}),
      ...(input.suggestionKey !== undefined
        ? { suggestionKey: input.suggestionKey }
        : {}),
    },
  });
}

function failedResult(
  failureCode: PermissionClassifierFailureCode,
  startedAt: number,
  error?: unknown,
  model?: string,
): PermissionClassifierResult {
  logger.warn(
    { failureCode, reasonCode: failureCode, ...(error ? { error } : {}) },
    'Permission classifier consultation failed',
  );
  return {
    status:
      failureCode === 'aborted' || failureCode === 'input_truncated'
        ? PermissionClassifierStatus.Skipped
        : PermissionClassifierStatus.Unavailable,
    risk_level: 'high',
    reason: `Classifier unavailable (${failureCode}); ask the user.`,
    latencyMs: Date.now() - startedAt,
    ...(model ? { model } : {}),
    failureCode,
  };
}

function isClassifierTimeoutError(error: unknown): boolean {
  return (
    isMemoryOperationTimeoutError(error) ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
