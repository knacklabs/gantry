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
  resolveTurnAllowedTools,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillIds,
} from './group-run-context.js';
import {
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
const DEFAULT_ASSISTANT_NAME = 'MyClaw';
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
      turnMessages?: readonly { content?: string | null }[];
    },
  ): Promise<'success' | 'error'> {
    const sessionThreadId = options?.memoryContext?.threadId ?? null;
    const modelStatus = createRuntimeModelStatusAccess(
      group.folder,
      sessionThreadId,
    );
    const streamedResult = createRuntimeResultSummaryAccumulator();
    let latestProviderSessionId: string | undefined;
    const persistedProviderSessionIds = new Set<string>();
    const turnContext = await ops().getAgentTurnContext?.({
      agentFolder: group.folder,
      conversationJid: chatJid,
      threadId: sessionThreadId,
      conversationKind: group.conversationKind,
      memoryUserId: options?.memoryContext?.userId,
      query:
        options?.memoryContext?.source === 'message'
          ? buildBoundedMemoryRecallQuery(options.memoryContext.recallQuery)
          : undefined,
    });
    const persistProviderSessionId = async (
      providerSessionId: string | undefined,
    ) => {
      if (
        !providerSessionId ||
        !turnContext?.agentSessionId ||
        persistedProviderSessionIds.has(providerSessionId)
      ) {
        return;
      }
      const persisted = await ops().setSession(
        group.folder,
        providerSessionId,
        sessionThreadId,
        {
          conversationJid: chatJid,
          conversationKind: group.conversationKind,
          memoryUserId: options?.memoryContext?.userId,
          expectedAgentSessionId: turnContext.agentSessionId,
          expectedAgentSessionResetAt: turnContext.agentSessionResetAt ?? null,
        },
      );
      if (persisted === false) return;
      persistedProviderSessionIds.add(providerSessionId);
    };
    let defaultRuntimeModel: string | undefined;
    const defaultMemoryScope = memoryScopeForConversationKind(
      group.conversationKind,
    );
    const memoryReviewerIsControlApprover = await memoryReviewerApproverAllowed(
      deps,
      chatJid,
      group.folder,
      options?.memoryContext?.userId,
    );
    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
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
          if (output.status !== 'error' && output.newSessionId) {
            latestProviderSessionId = output.newSessionId;
            await persistProviderSessionId(output.newSessionId);
          }
          if (output.status !== 'error' && output.result) {
            streamedResult.append(String(output.result));
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
          await onOutput(output);
        }
      : undefined;
    const approvedSkillContextBlock = await buildApprovedSkillContextBlock({
      skillRepository: deps.getSkillRepository?.(),
      skillArtifactStore: deps.getSkillArtifactStore?.(),
      turnContext,
    });
    const [configuredAllowedTools, selectedSkillIds, selectedMcpServerIds] =
      await Promise.all([
        resolveTurnAllowedTools(deps, turnContext),
        resolveTurnSelectedSkillIds(deps, turnContext),
        resolveTurnSelectedMcpServerIds(deps, turnContext),
      ]);
    const memoryContextBlock = [
      turnContext?.memoryContextBlock,
      approvedSkillContextBlock,
    ]
      .filter((block): block is string => Boolean(block?.trim()))
      .join('\n\n');
    const runId = turnContext?.agentSessionId
      ? await ops().createSessionAgentRun?.({
          agentSessionId: turnContext.agentSessionId,
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
        mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
        mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
        turnContext,
      });
      const invokeAgent = (agentInput: { memoryContextBlock?: string }) =>
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
            allowedTools: configuredAllowedTools,
            selectedSkillIds,
            selectedMcpServerIds,
            ...(turnContext?.externalSessionId
              ? { sessionId: turnContext.externalSessionId }
              : {}),
            assistantName: group.trigger || DEFAULT_ASSISTANT_NAME,
            thinking: group.agentConfig?.thinking,
            memoryContextBlock: agentInput.memoryContextBlock,
            [WORKSPACE_FOLDER_INPUT_KEY]: group.folder,
          } as Parameters<typeof runAgentImpl>[1],
          (proc, runHandle) =>
            deps.queue.registerProcess(
              queueJid,
              proc,
              runHandle,
              group.folder,
              queueJid === chatJid ? undefined : chatJid,
              options?.memoryContext?.threadId,
            ),
          wrappedOnOutput,
          runOptions,
        );
      const output = await invokeAgent({ memoryContextBlock });
      if (output.status === 'error') {
        runtimeLogger.error(
          { group: group.name, error: output.error },
          'Agent runner error',
        );
        await completeFailedRuntimeSessionRun({
          ops: ops(),
          runId,
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
        providerSessionId: persistedProviderSessionIds.has(
          output.newSessionId ?? latestProviderSessionId ?? '',
        )
          ? undefined
          : (output.newSessionId ?? latestProviderSessionId),
        runId,
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
        runId,
        errorSummary: err instanceof Error ? err.message : String(err),
      });
      return 'error';
    }
  };
}
