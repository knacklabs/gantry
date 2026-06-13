import type { ConversationRoute } from '../domain/types.js';
import { collectCompactBoundaryMemory } from '../jobs/compact-memory.js';
import { defaultModelStatusSelection } from '../session/session-model-status.js';
import type { AgentOutput } from './agent-spawn.js';
import { spawnAgent } from './agent-spawn.js';
import type {
  GroupProcessingDeps,
  GroupProcessingRepository,
} from './group-processing-types.js';
import {
  memoryScopeForConversationKind,
  resolveTurnToolPolicy,
  resolveTurnSemanticCapabilities,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
} from './group-run-context.js';
import {
  resolveSingleNonSelfSenderId,
  buildApprovedSkillContextBlock,
  buildRuntimeRunOptions,
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeResultSummaryAccumulator,
  summarizeRuntimeResultForPersistence,
} from './session-resume-runtime.js';
import { createRuntimeModelStatusAccess } from './model-status-store.js';
import { recordRuntimeModelUsage } from './model-status-output.js';
import { buildBoundedMemoryRecallQuery } from '../memory/app-memory-recall-query.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { flowLog } from '../shared/flow-log.js';
import {
  isRuntimeEventType,
  RUNTIME_EVENT_TYPES,
} from '../domain/events/runtime-event-types.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
const DEFAULT_ASSISTANT_NAME = 'Gantry';
const DEFAULT_MODEL_ALIAS = 'opus';
const MEMORY_REVIEW_APPROVER_CACHE_TTL_MS = 60_000;
const WORKSPACE_FOLDER_INPUT_KEY = `group${'Folder'}`;
const RUNTIME_LOG_PROVIDER_FIELDS =
  'sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id';
const RUNTIME_LOG_PROVIDER_FIELD_PATTERNS: RegExp[] = [
  new RegExp(
    `(["'](?:${RUNTIME_LOG_PROVIDER_FIELDS})["']\\s*:\\s*")([^"\\r\\n]*)(")`,
    'gi',
  ),
  new RegExp(
    `(["'](?:${RUNTIME_LOG_PROVIDER_FIELDS})["']\\s*:\\s*')([^'\\r\\n]*)(')`,
    'gi',
  ),
  new RegExp(
    `\\b((?:${RUNTIME_LOG_PROVIDER_FIELDS})\\s*[:=]\\s*)([^\\s"',}\\]]+)`,
    'gi',
  ),
  new RegExp(
    `\\b((?:${RUNTIME_LOG_PROVIDER_FIELDS})\\s+)([^\\s"',}\\]]+)`,
    'gi',
  ),
];
const RUNTIME_LOG_PROVIDER_VALUE_PATTERNS: RegExp[] = [
  /\bclaude-session-[A-Za-z0-9._:-]+\b/g,
  /\bprovider-session:[A-Za-z0-9._:-]+\b/g,
];
const RUNTIME_LOG_REDACT_KEY_PATTERN =
  /^(sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)$/i;
const memoryReviewApproverCache = new Map<string, [boolean, number]>();
function isMissingProviderSessionError(error: string | undefined): boolean {
  return /\bNo conversation found with session ID\b/i.test(error ?? '');
}
function redactRuntimeLogString(value: string): string {
  let out = value;
  for (const pattern of RUNTIME_LOG_PROVIDER_FIELD_PATTERNS) {
    out = out.replace(pattern, (_match, prefix, _secret, suffix = '') => {
      return `${prefix}[REDACTED]${suffix}`;
    });
  }
  for (const pattern of RUNTIME_LOG_PROVIDER_VALUE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}
function redactRuntimeLogValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return redactRuntimeLogString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactRuntimeLogValue(entry, depth + 1));
  }
  if (value instanceof Error) {
    const errorPayload: Record<string, unknown> = {
      type: value.constructor?.name || 'Error',
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    const withCause = value as Error & {
      cause?: unknown;
      code?: unknown;
    };
    if ('code' in withCause) {
      errorPayload.code = withCause.code;
    }
    if ('cause' in withCause) {
      errorPayload.cause = withCause.cause;
    }
    return redactRuntimeLogValue(errorPayload, depth + 1);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (RUNTIME_LOG_REDACT_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactRuntimeLogValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}
async function memoryReviewerApproverAllowed(
  deps: GroupProcessingDeps,
  conversationJid: string,
  sourceAgentFolder: string,
  userId?: string,
): Promise<boolean> {
  if (!userId) return false;
  const hook = deps.channelRuntime.isControlApproverAllowed;
  if (!hook) return false;
  const key = `${conversationJid}\0${sourceAgentFolder}\0${userId}`;
  const now = currentTimeMs();
  const cached = memoryReviewApproverCache.get(key);
  if (cached && cached[1] > now) return cached[0];
  const allowed =
    (await hook({
      conversationJid,
      userId,
      sourceAgentFolder,
      decisionPolicy: 'same_channel',
    }).catch(() => false)) === true;
  memoryReviewApproverCache.set(key, [
    allowed,
    now + MEMORY_REVIEW_APPROVER_CACHE_TTL_MS,
  ]);
  return allowed;
}
const runtimeLogger = {
  info(payload: Record<string, unknown>, message: string) {
    console.info(
      redactRuntimeLogString(message),
      redactRuntimeLogValue(payload, 0),
    );
  },
  warn(payload: Record<string, unknown>, message: string) {
    console.warn(
      redactRuntimeLogString(message),
      redactRuntimeLogValue(payload, 0),
    );
  },
  error(payload: Record<string, unknown>, message: string) {
    console.error(
      redactRuntimeLogString(message),
      redactRuntimeLogValue(payload, 0),
    );
  },
};
// FlowLogger-shaped adapter over the redacting runtimeLogger, so flow events
// reuse this module's logger instead of importing the infrastructure logger.
const flowLogger = {
  info: (data: string | Record<string, unknown>, msg?: string) =>
    runtimeLogger.info(
      typeof data === 'string' ? {} : data,
      typeof data === 'string' ? data : (msg ?? ''),
    ),
};
export function createGroupAgentRunner(input: {
  deps: GroupProcessingDeps;
  ops: () => GroupProcessingRepository;
}) {
  const { deps, ops } = input;
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const collectSessionMemory = deps.collectSessionMemory;
  return async function runAgent(
    group: ConversationRoute,
    prompt: string,
    chatJid: string,
    queueJid: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
    options?: {
      timeoutMs?: number;
      memoryContext?: {
        source: 'message' | 'command';
        userId?: string;
        threadId?: string;
        recallQuery?: string;
      };
      turnMessages?: readonly {
        content?: string | null;
        sender?: string | null;
        is_from_me?: boolean | null;
      }[];
      guardrailSystemPromptAppend?: string;
      /**
       * Best-effort: receives the spawn run handle (and resolved appId) once the
       * child process is registered. Used to drain that run's MCP-call trace
       * records at persist time (the same handle the IPC proxy keys records by).
       */
      onRunStart?: (info: { runHandle: string; appId?: string }) => void;
    },
  ): Promise<'success' | 'error'> {
    const initialModelSelection = defaultModelStatusSelection(
      group.agentConfig?.model ?? DEFAULT_MODEL_ALIAS,
    );
    const executionProviderId = (initialModelSelection.model
      ?.executionProviderId ??
      resolveRuntimeExecutionProviderId(
        deps.executionAdapter,
      )) as ExecutionProviderId;
    const sessionThreadId = options?.memoryContext?.threadId ?? null;
    const modelStatus = createRuntimeModelStatusAccess(
      group.folder,
      sessionThreadId,
    );
    const streamedResult = createRuntimeResultSummaryAccumulator();
    const turnContext = await ops().getAgentTurnContext?.({
      agentFolder: group.folder,
      executionProviderId,
      conversationJid: chatJid,
      threadId: sessionThreadId,
      conversationKind: group.conversationKind,
      memoryUserId: options?.memoryContext?.userId,
      query:
        options?.memoryContext?.source === 'message'
          ? buildBoundedMemoryRecallQuery(options.memoryContext.recallQuery)
          : undefined,
    });
    let defaultRuntimeModel: string | undefined;
    const defaultMemoryScope = memoryScopeForConversationKind(
      group.conversationKind,
    );
    const memoryReviewerUserId = resolveSingleNonSelfSenderId(
      options?.turnMessages ?? [],
    );
    const memoryReviewerIsControlApprover = await memoryReviewerApproverAllowed(
      deps,
      chatJid,
      group.folder,
      memoryReviewerUserId,
    );
    const runState: { runId?: string } = {};
    let latestProviderSessionId =
      turnContext?.externalSessionId?.trim() || undefined;
    const updateRunProviderMetadata = async (input: {
      providerRunId?: string | null;
      providerSessionId?: string | null;
    }): Promise<void> => {
      if (!runState.runId) return;
      const repository = ops();
      if (!repository.updateAgentRunProviderMetadata) return;
      await repository
        .updateAgentRunProviderMetadata({ runId: runState.runId, ...input })
        .catch((err) => {
          runtimeLogger.warn(
            { err, group: group.name, runId: runState.runId },
            'Failed to update runtime run provider metadata',
          );
        });
    };
    const persistProviderSessionFromOutput = async (output: AgentOutput) => {
      if (output.status === 'error') return;
      const nextSessionId = output.newSessionId?.trim();
      if (
        !nextSessionId ||
        nextSessionId === latestProviderSessionId ||
        !turnContext?.agentSessionId ||
        !ops().setSession
      ) {
        return;
      }
      const persisted = await ops().setSession(
        group.folder,
        nextSessionId,
        sessionThreadId,
        {
          executionProviderId,
          conversationJid: chatJid,
          conversationKind: group.conversationKind,
          memoryUserId: options?.memoryContext?.userId,
          expectedAgentSessionId: turnContext.agentSessionId,
          expectedAgentSessionResetAt: turnContext.agentSessionResetAt ?? null,
        },
      );
      if (persisted === false) {
        runtimeLogger.warn(
          { group: group.name },
          'Provider session update skipped because turn ownership changed',
        );
        return;
      }
      latestProviderSessionId = nextSessionId;
      await updateRunProviderMetadata({ providerSessionId: nextSessionId });
    };
    const wrappedOnOutput = async (output: AgentOutput) => {
      await persistProviderSessionFromOutput(output);
      if (output.usage) {
        recordRuntimeModelUsage({
          group,
          threadId: sessionThreadId,
          usage: output.usage,
          usageEventId: output.usageEventId,
          getDefaultModel: () => {
            defaultRuntimeModel ??=
              group.agentConfig?.model ?? DEFAULT_MODEL_ALIAS;
            return defaultRuntimeModel;
          },
        });
        // Continuous measurement: every turn's model spend is traceable (flow
        // log) and durable (runtime event), so latency numbers always carry
        // their account-pressure context.
        // Field names deliberately avoid the substring "token" — the pino
        // redaction config scrubs any key matching it, and these are counts,
        // not credentials.
        flowLog(flowLogger, 'model.usage', {
          chatJid,
          model: output.usage.model,
          input: output.usage.inputTokens,
          output: output.usage.outputTokens,
          cacheRead: output.usage.cacheReadTokens,
          cacheWrite: output.usage.cacheWriteTokens,
          billableInput: output.usage.totalBillableInputTokens,
          costUsd: output.usage.estimatedCostUsd,
          usageEventId: output.usageEventId,
        });
        if (deps.publishRuntimeEvent && turnContext?.appId) {
          try {
            await deps.publishRuntimeEvent({
              appId: turnContext.appId as never,
              ...(turnContext.agentId
                ? { agentId: turnContext.agentId as never }
                : {}),
              ...(runState.runId ? { runId: runState.runId as never } : {}),
              conversationId: chatJid as never,
              ...(sessionThreadId
                ? { threadId: sessionThreadId as never }
                : {}),
              eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
              actor: 'runner',
              responseMode: 'none',
              payload: {
                ...output.usage,
                ...(output.usageEventId
                  ? { usageEventId: output.usageEventId }
                  : {}),
              },
            });
            // eslint-disable-next-line no-catch-all/no-catch-all -- telemetry persistence must never block the reply path; failure is logged.
          } catch (err) {
            runtimeLogger.warn(
              { err, group: group.name },
              'Failed to persist model usage runtime event',
            );
          }
        }
      }
      for (const event of output.runtimeEvents ?? []) {
        if (event.eventType !== RUNTIME_EVENT_TYPES.MODEL_RATE_LIMIT) continue;
        const payload =
          event.payload && typeof event.payload === 'object'
            ? (event.payload as Record<string, unknown>)
            : {};
        // Session ids stay out of logs (runtime-log redaction policy); the
        // durable runtime event keeps the full payload.
        const { providerSessionId: _providerSessionId, ...loggablePayload } =
          payload;
        flowLog(flowLogger, 'model.rate_limit', {
          chatJid,
          ...loggablePayload,
        });
      }
      if (output.contextUsage) {
        modelStatus.updateSelection({
          ...defaultModelStatusSelection(
            group.agentConfig?.model ??
              (defaultRuntimeModel ??=
                group.agentConfig?.model ?? DEFAULT_MODEL_ALIAS),
          ),
          selectionSource: group.agentConfig?.model
            ? 'session override'
            : 'chat default',
          contextUsage: output.contextUsage,
        });
      }
      if (output.status !== 'error' && output.result) {
        streamedResult.append(String(output.result));
      }
      if (output.runtimeEvents?.length && deps.publishRuntimeEvent) {
        for (const event of output.runtimeEvents) {
          if (!isRuntimeEventType(event.eventType)) continue;
          const appId = event.appId ?? turnContext?.appId;
          if (!appId) continue;
          await deps.publishRuntimeEvent({
            appId: appId as never,
            ...((event.agentId ?? turnContext?.agentId)
              ? {
                  agentId: (event.agentId ?? turnContext?.agentId) as never,
                }
              : {}),
            ...((event.runId ?? runState.runId)
              ? { runId: (event.runId ?? runState.runId) as never }
              : {}),
            ...(event.jobId ? { jobId: event.jobId as never } : {}),
            conversationId: (event.conversationId ?? chatJid) as never,
            ...((event.threadId ?? sessionThreadId)
              ? {
                  threadId: (event.threadId ?? sessionThreadId) as never,
                }
              : {}),
            eventType: event.eventType,
            actor: event.actor ?? 'runner',
            responseMode: event.responseMode ?? 'none',
            payload: event.payload,
          });
        }
      }
      if (
        output.compactBoundary &&
        turnContext?.agentSessionId &&
        collectSessionMemory
      ) {
        await collectCompactBoundaryMemory({
          compactBoundary: output.compactBoundary,
          agentSessionId: turnContext.agentSessionId,
          collectMemory: collectSessionMemory,
          defaultScope: defaultMemoryScope,
          logger: runtimeLogger,
          context: { group: group.name },
        });
      }
      await onOutput?.(output);
    };
    const approvedSkillContextBlock = await buildApprovedSkillContextBlock({
      skillRepository: deps.getSkillRepository?.(),
      skillArtifactStore: deps.getSkillArtifactStore?.(),
      turnContext,
    });
    const [configuredToolPolicy, selectedSkillContext, semanticCapabilities] =
      await Promise.all([
        resolveTurnToolPolicy(deps, turnContext),
        resolveTurnSelectedSkillContext(deps, turnContext),
        resolveTurnSemanticCapabilities(deps, turnContext),
      ]);
    const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
      deps,
      turnContext,
      configuredToolPolicy.allowedTools,
    );
    const memoryContextBlock = [
      turnContext?.memoryContextBlock,
      approvedSkillContextBlock,
    ]
      .filter((block): block is string => Boolean(block?.trim()))
      .join('\n\n');
    runState.runId = turnContext?.agentSessionId
      ? await ops().createSessionAgentRun?.({
          agentSessionId: turnContext.agentSessionId,
          executionProviderId,
          providerSessionId: turnContext.providerSessionId,
          cause:
            options?.memoryContext?.source === 'command'
              ? 'control'
              : 'message',
        })
      : undefined;
    try {
      const credentialBroker = await deps.getCredentialBroker?.();
      const runOptions = buildRuntimeRunOptions({
        timeoutMs: options?.timeoutMs,
        credentialBroker,
        skillRepository: deps.getSkillRepository?.(),
        skillArtifactStore: deps.getSkillArtifactStore?.(),
        mcpServerRepository: deps.getMcpServerRepository?.(),
        capabilitySecretRepository: deps.getCapabilitySecretRepository?.(),
        mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
        mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
        publishRuntimeEvent: deps.publishRuntimeEvent,
        executionAdapter: deps.executionAdapter,
        executionAdapters: deps.executionAdapters,
        turnContext,
      });
      const expireTurnProviderSession = async (
        reason: string,
      ): Promise<boolean> => {
        if (
          !turnContext?.providerSessionId ||
          !turnContext.agentSessionId ||
          !turnContext.externalSessionId ||
          !ops().expireProviderSession
        ) {
          return false;
        }
        await ops().expireProviderSession?.({
          providerSessionId: turnContext.providerSessionId,
          agentSessionId: turnContext.agentSessionId,
          provider: executionProviderId,
          externalSessionId: turnContext.externalSessionId,
        });
        latestProviderSessionId = undefined;
        await updateRunProviderMetadata({ providerSessionId: null });
        runtimeLogger.warn(
          { group: group.name, reason },
          'Expired stale provider session and retrying without resume',
        );
        return true;
      };
      const invokeAgent = (agentInput: {
        memoryContextBlock?: string;
        resumeSessionId?: string;
      }) =>
        runAgentImpl(
          group,
          {
            prompt,
            ...(turnContext?.appId ? { appId: turnContext.appId } : {}),
            ...(turnContext?.agentId ? { agentId: turnContext.agentId } : {}),
            chatJid,
            threadId: options?.memoryContext?.threadId,
            memoryUserId: options?.memoryContext?.userId,
            memoryDefaultScope: defaultMemoryScope,
            memoryReviewerIsControlApprover,
            persona: group.agentConfig?.persona,
            allowedTools: configuredToolPolicy.allowedTools,
            gantryMcpToolSurface: group.agentConfig?.toolSurface?.gantryMcp,
            nativeToolSurface: group.agentConfig?.toolSurface?.native,
            runtimeAccess: configuredToolPolicy.runtimeAccess,
            attachedSkillSourceIds: selectedSkillContext.ids,
            selectedSkillDisplays: selectedSkillContext.displays,
            attachedMcpSourceIds,
            semanticCapabilities,
            assistantName: group.trigger || DEFAULT_ASSISTANT_NAME,
            thinking: group.agentConfig?.thinking,
            memoryContextBlock: agentInput.memoryContextBlock,
            ...(options?.guardrailSystemPromptAppend
              ? {
                  guardrailSystemPromptAppend:
                    options.guardrailSystemPromptAppend,
                }
              : {}),
            ...(agentInput.resumeSessionId
              ? { sessionId: agentInput.resumeSessionId }
              : {}),
            [WORKSPACE_FOLDER_INPUT_KEY]: group.folder,
          } as Parameters<typeof runAgentImpl>[1],
          (proc, runHandle) => {
            void updateRunProviderMetadata({ providerRunId: runHandle });
            // Surface the run handle for best-effort latency-trace drain. The
            // IPC proxy keys MCP-call records by this same handle.
            try {
              options?.onRunStart?.({ runHandle, appId: turnContext?.appId });
            } catch {
              // never let trace bookkeeping affect the run
            }
            const registerOptions =
              memoryReviewerIsControlApprover && memoryReviewerUserId
                ? { requiredContinuationUserId: memoryReviewerUserId }
                : undefined;
            if (registerOptions) {
              deps.queue.registerProcess(
                queueJid,
                proc,
                runHandle,
                group.folder,
                queueJid === chatJid ? undefined : chatJid,
                options?.memoryContext?.threadId,
                registerOptions,
              );
              return;
            }
            deps.queue.registerProcess(
              queueJid,
              proc,
              runHandle,
              group.folder,
              queueJid === chatJid ? undefined : chatJid,
              options?.memoryContext?.threadId,
            );
          },
          wrappedOnOutput,
          runOptions,
        );
      let output = await invokeAgent({
        memoryContextBlock,
        resumeSessionId: turnContext?.externalSessionId,
      });
      if (
        output.status === 'error' &&
        isMissingProviderSessionError(output.error) &&
        (await expireTurnProviderSession(output.error ?? 'missing session'))
      ) {
        output = await invokeAgent({ memoryContextBlock });
      }
      if (output.status === 'error') {
        runtimeLogger.error(
          { group: group.name, error: output.error },
          'Agent runner error',
        );
        await completeFailedRuntimeSessionRun({
          ops: ops(),
          runId: runState.runId,
          errorSummary: output.error ?? 'Agent runner error',
        });
        return 'error';
      }
      await completeSuccessfulRuntimeSessionRun({
        ops: ops(),
        group,
        chatJid,
        threadId: sessionThreadId,
        conversationKind: group.conversationKind,
        memoryUserId: options?.memoryContext?.userId,
        agentSessionId: turnContext?.agentSessionId,
        agentSessionResetAt: turnContext?.agentSessionResetAt ?? null,
        runId: runState.runId,
        result:
          output.result == null
            ? streamedResult.snapshot()
            : summarizeRuntimeResultForPersistence(output.result),
      });
      return 'success';
    } catch (err) {
      runtimeLogger.error({ group: group.name, err }, 'Agent error');
      await completeFailedRuntimeSessionRun({
        ops: ops(),
        runId: runState.runId,
        errorSummary: err instanceof Error ? err.message : String(err),
      });
      return 'error';
    }
  };
}
