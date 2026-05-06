import {
  ASSISTANT_NAME,
  getDefaultModelConfig,
  getTriggerPattern,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
} from '../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  MessageSendOptions,
  ProgressUpdateOptions,
  ConversationRoute,
} from '../domain/types.js';
import {
  createSerializedAgentOutputCallbacks,
  isAgentTurnCompleteMarker,
} from './agent-output-callbacks.js';
import {
  buildDoneProgressOptions,
  buildReplaceOnlyProgressOptions,
  sendFinalProgressUpdate,
} from './progress-updates.js';
import { finalizeGroupAgentUserVisibleOutput } from './group-output-finalization.js';
import { createStreamingOutputState } from './streaming-output-state.js';
import {
  formatMessages,
  formatOutboundForChannel,
} from '../messaging/router.js';
import { collectCompactBoundaryMemory } from '../jobs/compact-memory.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import { AgentOutput, spawnAgent } from './agent-spawn.js';
import { handleSessionCommand } from '../session/session-commands.js';
import { defaultModelStatusSelection } from '../session/session-model-status.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import { getGroupMemoryStatus } from './group-memory-commands.js';
import { runDreamingForGroup } from './memory-dreaming-runner.js';
import { sendWithPartialDeliveryGuard } from './partial-delivery.js';
import {
  buildApprovedSkillContextBlock,
  buildRuntimeRunOptions,
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  resolveMemoryUserId,
} from './session-resume-runtime.js';
import { firstThreadQueueId, parseThreadQueueKey } from './thread-queue-key.js';
import { formatElapsed } from './time-format.js';
import { createRuntimeModelStatusAccess } from './model-status-store.js';
import { recordRuntimeModelUsage } from './model-status-output.js';
import {
  memoryScopeForConversationKind,
  resolveTurnAllowedTools,
} from './group-run-context.js';
import { getGroupBrowserStatus } from './group-browser-status.js';
import { handleFailure, waitOutput } from './group-processing-flow.js';
import {
  createAdvanceCursorHandler,
  createArchiveCurrentSessionHandler,
  createSaveProcedureHandler,
  createSenderCommandPolicy,
} from './group-session-command-state.js';
const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
const ELAPSED_PROGRESS_INTERVAL_MS = 60_000;
const NO_OUTPUT_WARNING_INTERVAL_MS = 180_000;
let streamingGenerationCounter = 0;

export function createGroupProcessor(deps: GroupProcessingDeps) {
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const collectSessionMemory = deps.collectSessionMemory;
  const ops = () => {
    const repository = deps.opsRepository ?? deps.getRuntimeRepository?.();
    if (!repository) {
      throw new Error(
        'Group processor requires runtime message and session repositories',
      );
    }
    return repository;
  };
  async function runAgent(
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
      };
    },
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionThreadId = options?.memoryContext?.threadId ?? null;
    const modelStatus = createRuntimeModelStatusAccess(
      group.folder,
      sessionThreadId,
    );
    let streamedResult = '';
    let latestProviderSessionId: string | undefined;
    const persistedProviderSessionIds = new Set<string>();
    const turnContext = await ops().getAgentTurnContext?.({
      agentFolder: group.folder,
      conversationJid: chatJid,
      threadId: sessionThreadId,
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
      await ops().setSession(group.folder, providerSessionId, sessionThreadId, {
        conversationJid: chatJid,
      });
      persistedProviderSessionIds.add(providerSessionId);
    };
    let defaultRuntimeModel: string | undefined;
    const defaultMemoryScope = memoryScopeForConversationKind(
      group.conversationKind,
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
                defaultRuntimeModel ??= getDefaultModelConfig().model;
                return defaultRuntimeModel;
              },
            });
          }
          if (output.contextUsage) {
            modelStatus.updateSelection({
              ...defaultModelStatusSelection(
                group.agentConfig?.model ??
                  (defaultRuntimeModel ??= getDefaultModelConfig().model),
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
            streamedResult += String(output.result);
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
              logger,
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
    const configuredAllowedTools = await resolveTurnAllowedTools(
      deps,
      turnContext,
    );
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
      const invokeAgent = (input: { memoryContextBlock?: string }) =>
        runAgentImpl(
          group,
          {
            prompt,
            groupFolder: group.folder,
            chatJid,
            threadId: options?.memoryContext?.threadId,
            memoryUserId: options?.memoryContext?.userId,
            memoryDefaultScope: defaultMemoryScope,
            persona: group.agentConfig?.persona,
            allowedTools: configuredAllowedTools,
            ...(turnContext?.externalSessionId
              ? { sessionId: turnContext.externalSessionId }
              : {}),
            isMain,
            assistantName: ASSISTANT_NAME,
            thinking: group.agentConfig?.thinking,
            memoryContextBlock: input.memoryContextBlock,
          },
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
      const output = await invokeAgent({
        memoryContextBlock,
      });
      if (output.status === 'error') {
        logger.error(
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
        agentSessionId: turnContext?.agentSessionId,
        providerSessionId: persistedProviderSessionIds.has(
          output.newSessionId ?? latestProviderSessionId ?? '',
        )
          ? undefined
          : (output.newSessionId ?? latestProviderSessionId),
        runId,
        result: output.result ?? (streamedResult.trim() || null),
      });

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      await completeFailedRuntimeSessionRun({
        ops: ops(),
        runId,
        errorSummary: err instanceof Error ? err.message : String(err),
      });
      return 'error';
    }
  }

  async function processGroupMessages(
    queueJid: string,
    options: { queued?: boolean } = {},
  ): Promise<boolean> {
    const { chatJid, threadId: queueThreadId } = parseThreadQueueKey(queueJid);
    const group = deps.getGroup(chatJid);
    if (!group) return true;

    if (!deps.channelRuntime.hasChannel(chatJid)) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const scopedQueue = options.queued === true || queueThreadId !== undefined;
    const messageFilter = scopedQueue
      ? { threadId: queueThreadId ?? null }
      : undefined;
    const missedMessages = await ops().getMessagesSince(
      chatJid,
      await deps.getCursor(queueJid),
      MAX_MESSAGES_PER_PROMPT,
      messageFilter,
    );

    if (missedMessages.length === 0) return true;

    const latestMessage = missedMessages[missedMessages.length - 1];
    const activeThreadId = firstThreadQueueId(
      queueThreadId,
      latestMessage.thread_id,
    );
    const resolveThreadId = (threadId?: string) => threadId ?? activeThreadId;
    let streamGeneration = (streamingGenerationCounter += 1);
    const buildMessageOptions = (threadId?: string) => {
      const resolved = resolveThreadId(threadId);
      return resolved ? { threadId: resolved } : undefined;
    };
    const buildStreamingOptions = (args: {
      threadId?: string;
      done?: boolean;
    }) => ({
      generation: streamGeneration,
      ...(resolveThreadId(args.threadId)
        ? { threadId: resolveThreadId(args.threadId) }
        : {}),
      ...(args.done !== undefined ? { done: args.done } : {}),
    });
    const sendMessageToChannel = async (
      text: string,
      options?: MessageSendOptions,
    ): Promise<void> =>
      void (await (options
        ? deps.channelRuntime.sendMessage(chatJid, text, options)
        : deps.channelRuntime.sendMessage(chatJid, text)));
    const sendProgressToChannel = async (
      text: string,
      options?: ProgressUpdateOptions,
    ): Promise<void> =>
      options
        ? deps.channelRuntime.sendProgressUpdate(chatJid, text, options)
        : deps.channelRuntime.sendProgressUpdate(chatJid, text);
    const memoryUserId = resolveMemoryUserId(missedMessages);
    const defaultMemoryScope = memoryScopeForConversationKind(
      group.conversationKind,
    );

    const modelStatus = createRuntimeModelStatusAccess(
      group.folder,
      activeThreadId,
    );
    const senderCommandPolicy = createSenderCommandPolicy({
      chatJid,
      group,
      isMainGroup,
      triggerPattern: getTriggerPattern(group.trigger),
    });
    const cmdResult = await handleSessionCommand({
      missedMessages,
      isMainGroup,
      groupName: group.name,
      triggerPattern: getTriggerPattern(group.trigger),
      timezone: TIMEZONE,
      deps: {
        sendMessage: (text, options) =>
          sendMessageToChannel(text, buildMessageOptions(options?.threadId)),
        setTyping: (typing) => deps.channelRuntime.setTyping(chatJid, typing),
        runAgent: (prompt, onOutput, options) =>
          runAgent(group, prompt, chatJid, queueJid, onOutput, {
            ...options,
            memoryContext: {
              source: 'command',
              userId: memoryUserId,
              threadId: activeThreadId,
            },
          }),
        closeStdin: () => deps.queue.closeStdin(queueJid),
        advanceCursor: createAdvanceCursorHandler({
          queueJid,
          setCursor: deps.setCursor,
          saveState: deps.saveState,
          warn: (err) =>
            logger.warn(
              { group: group.name, err },
              'Failed to persist session command cursor',
            ),
        }),
        formatMessages,
        getDefaultModel: () =>
          getDefaultModelConfig('interactive', group.folder).model,
        getJobModelDefaults: () => ({
          oneTime: getDefaultModelConfig('oneTimeJob', group.folder).model,
          recurring: getDefaultModelConfig('recurringJob', group.folder).model,
        }),
        getGroupModelOverride: () => group.agentConfig?.model,
        setGroupModelOverride: async (value) =>
          deps.setGroupModelOverride(chatJid, value),
        getModelStatus: modelStatus.getStatus,
        getBrowserStatus: () => getGroupBrowserStatus({ group, chatJid }),
        updateModelStatusSelection: modelStatus.updateSelection,
        getGroupThinkingOverride: () => group.agentConfig?.thinking,
        setGroupThinkingOverride: async (value) =>
          deps.setGroupThinkingOverride(chatJid, value),
        archiveCurrentSession: createArchiveCurrentSessionHandler({
          ops,
          group,
          chatJid,
          threadId: activeThreadId ?? null,
          defaultScope: defaultMemoryScope,
          collectMemory: collectSessionMemory,
        }),
        clearCurrentSession: () =>
          deps.clearSession(group.folder, activeThreadId),
        stopCurrentRun: () => deps.queue.stopGroup?.(queueJid) ?? false,
        runMemoryDreaming: () => runDreamingForGroup(group.folder),
        getMemoryStatus: async () => getGroupMemoryStatus(group.folder),
        saveProcedure: createSaveProcedureHandler({
          folder: group.folder,
          threadId: activeThreadId,
          isAdminWrite: isMainGroup,
        }),
        ...senderCommandPolicy,
      },
    });
    if (cmdResult.handled) return cmdResult.success;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          triggerPattern.test(m.content.trim()) &&
          (m.is_from_me ||
            isTriggerAllowed(chatJid, m.sender, allowlistCfg, group.folder)),
      );
      if (!hasTrigger) {
        return true;
      }
    }

    const prompt = formatMessages(missedMessages, TIMEZONE);
    const previousCursor = (await deps.getCursor(queueJid)) || '';
    deps.setCursor(
      queueJid,
      encodeGroupMessageCursor(
        toGroupMessageCursor(missedMessages[missedMessages.length - 1]),
      ),
    );
    await deps.saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );
    try {
      deps.channelRuntime.resetStreaming(chatJid);
    } catch (err) {
      logger.debug(
        { err, group: group.name },
        'Failed to reset channel streaming state before processing',
      );
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing agent runner stdin',
        );
        deps.queue.closeStdin(queueJid);
      }, IDLE_TIMEOUT);
    };

    let typingActive = false;
    const setTypingState = async (isTyping: boolean) => {
      typingActive = isTyping;
      await deps.channelRuntime.setTyping(chatJid, isTyping);
    };
    await setTypingState(true);
    const startedAt = Date.now();
    let lastAgentProgressAt = startedAt;
    let lastNoOutputWarningAt = 0;
    let lastElapsedProgressAt = 0;
    let typingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const supportsProgress = deps.channelRuntime.supportsProgress(chatJid);
    const sendDoneProgress = (failed: boolean) =>
      sendFinalProgressUpdate({
        enabled: supportsProgress,
        failed,
        elapsed: formatElapsed(Date.now() - startedAt),
        options: buildDoneProgressOptions(activeThreadId, true),
        send: sendProgressToChannel,
      });
    const sendWaitingProgress = () =>
      supportsProgress
        ? sendProgressToChannel(
            'Waiting for your input.',
            buildReplaceOnlyProgressOptions(activeThreadId),
          ).catch(() => undefined)
        : Promise.resolve();
    if (supportsProgress) {
      try {
        const progressOptions = await buildMessageOptions();
        await sendProgressToChannel('Working on it...', progressOptions);
      } catch (err) {
        logger.debug(
          { err, group: group.name },
          'Failed to send initial progress update',
        );
      }
    }
    typingHeartbeatTimer = setInterval(() => {
      if (!typingActive) return;
      void deps.channelRuntime
        .setTyping(chatJid, true)
        .catch((err) =>
          logger.debug(
            { err, group: group.name },
            'Failed to refresh typing heartbeat',
          ),
        );
    }, TYPING_HEARTBEAT_INTERVAL_MS);
    progressTimer = setInterval(() => {
      void (async () => {
        if (!supportsProgress || !typingActive) return;
        const now = Date.now();
        const elapsedMs = now - startedAt;
        if (now - lastElapsedProgressAt >= ELAPSED_PROGRESS_INTERVAL_MS) {
          lastElapsedProgressAt = now;
          const progressOptions = await buildMessageOptions();
          void sendProgressToChannel(
            `Still working (${formatElapsed(elapsedMs)})...`,
            progressOptions,
          ).catch((err) =>
            logger.debug(
              { err, group: group.name },
              'Failed to send elapsed progress update',
            ),
          );
        }
        if (
          now - lastAgentProgressAt >= NO_OUTPUT_WARNING_INTERVAL_MS &&
          now - lastNoOutputWarningAt >= NO_OUTPUT_WARNING_INTERVAL_MS
        ) {
          lastNoOutputWarningAt = now;
          const progressOptions = await buildMessageOptions();
          void sendProgressToChannel(
            `No new output yet, still running (${formatElapsed(elapsedMs)})...`,
            progressOptions,
          ).catch((err) =>
            logger.debug(
              { err, group: group.name },
              'Failed to send no-output warning',
            ),
          );
        }
      })();
    }, 5_000);
    let hadError = false;
    let outputSentToUser = false;
    let collectedOutput = '';
    let streamedOutputDelivered = false;
    let sawRawOutput = false;
    let pendingIdleBoundary = false;
    let outputCallbackError: unknown;
    const supportsStreamingChunks =
      deps.channelRuntime.supportsStreaming(chatJid);
    const streamingOutput = createStreamingOutputState({
      enabled: supportsStreamingChunks,
      finalizeChunk: async (reason) => {
        try {
          await deps.channelRuntime.sendStreamingChunk(
            chatJid,
            '',
            await buildStreamingOptions({ done: true }),
          );
        } catch (err) {
          logger.warn(
            { err, group: group.name, reason },
            'Failed to finalize streaming output',
          );
        }
      },
    });
    const finalizeStreamingOutput = streamingOutput.finalize;
    const startNextStreamingMessage = () => {
      streamGeneration = streamingGenerationCounter += 1;
      streamingOutput.startNext();
    };
    const notifyTurnIdle = () => {
      deps.queue.notifyIdle(queueJid);
      pendingIdleBoundary = false;
    };
    let output: 'success' | 'error' = 'error';
    const handleAgentOutput = async (result: AgentOutput) => {
      lastAgentProgressAt = Date.now();
      if (result.result) {
        if (!typingActive) {
          await setTypingState(true);
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        sawRawOutput = true;
        pendingIdleBoundary = true;
        const text = formatOutboundForChannel(raw);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          let delivered = false;
          if (supportsStreamingChunks) {
            streamingOutput.markContent();
            delivered = await deps.channelRuntime.sendStreamingChunk(
              chatJid,
              raw,
              await buildStreamingOptions({}),
            );
            if (delivered) streamedOutputDelivered = true;
          } else {
            const messageOptions = await buildMessageOptions();
            delivered = await sendWithPartialDeliveryGuard(
              () => sendMessageToChannel(text, messageOptions),
              { group: group.name },
            );
          }
          if (delivered) outputSentToUser = true;
          collectedOutput += `${text}\n`;
        }
        resetIdleTimer();
      }

      if (result.interactionBoundary) {
        pendingIdleBoundary = true;
        await finalizeStreamingOutput('interaction-boundary');
        startNextStreamingMessage();
        await sendWaitingProgress();
        await setTypingState(false);
        resetIdleTimer();
      }

      if (isAgentTurnCompleteMarker(result)) {
        await finalizeStreamingOutput('success-marker');
        notifyTurnIdle();
        startNextStreamingMessage();
        await sendDoneProgress(false);
        await setTypingState(false);
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
        await finalizeStreamingOutput('error-marker');
        await sendDoneProgress(true);
        await setTypingState(false);
      }
    };
    const outputCallbacks = createSerializedAgentOutputCallbacks({
      handle: handleAgentOutput,
      onError: (err) => {
        outputCallbackError ??= err;
      },
    });
    try {
      output = await runAgent(
        group,
        prompt,
        chatJid,
        queueJid,
        outputCallbacks.enqueue,
        {
          memoryContext: {
            source: 'message',
            userId: memoryUserId,
            threadId: activeThreadId,
          },
        },
      );
    } finally {
      hadError = await waitOutput({
        wait: outputCallbacks.wait,
        getError: () => outputCallbackError,
        hadError,
        groupName: group.name,
        logger,
      });
      await finalizeStreamingOutput('turn-complete');
      if (output === 'success' && pendingIdleBoundary) {
        notifyTurnIdle();
      }
      if (typingHeartbeatTimer) clearInterval(typingHeartbeatTimer);
      if (progressTimer) clearInterval(progressTimer);
      await sendDoneProgress(output === 'error' || hadError);
      await setTypingState(false);
      if (idleTimer) clearTimeout(idleTimer);
    }

    if (output === 'error' || hadError) {
      return handleFailure({
        outputSentToUser,
        groupName: group.name,
        queueJid,
        previousCursor,
        deps,
        logger,
      });
    }

    outputSentToUser = await finalizeGroupAgentUserVisibleOutput({
      streamedOutputDelivered,
      collectedOutput,
      chatJid,
      activeThreadId,
      outputSentToUser,
      sawRawOutput,
      groupName: group.name,
      warn: (metadata, message) => logger.warn(metadata, message),
      storeMessage: (message) => ops().storeMessage(message),
      buildMessageOptions,
      sendMessageToChannel,
    });

    return true;
  }

  return { processGroupMessages };
}
