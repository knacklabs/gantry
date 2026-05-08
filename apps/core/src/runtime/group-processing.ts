import {
  getDefaultModelConfig,
  getRuntimeSettingsForConfig,
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
import { MessageSendOptions, ProgressUpdateOptions } from '../domain/types.js';
import {
  createSerializedAgentOutputCallbacks,
  isAgentTurnCompleteMarker,
} from './agent-output-callbacks.js';
import {
  buildDoneProgressOptions,
  FinalProgressState,
  sendFinalProgressUpdate,
} from './progress-updates.js';
import { finalizeGroupAgentUserVisibleOutput } from './group-output-finalization.js';
import { createStreamingOutputState } from './streaming-output-state.js';
import {
  formatMessages,
  formatOutboundForChannel,
} from '../messaging/router.js';
import type { AgentOutput } from './agent-spawn.js';
import { handleSessionCommand } from '../session/session-commands.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import { getGroupMemoryStatus } from './group-memory-commands.js';
import { runDreamingForGroup } from './memory-dreaming-runner.js';
import { settleDeliveryAttempt } from '../jobs/delivery.js';
import {
  createRuntimeResultSummaryAccumulator,
  resolveMemoryUserId,
} from './session-resume-runtime.js';
import { firstThreadQueueId, parseThreadQueueKey } from './thread-queue-key.js';
import { formatElapsed } from './time-format.js';
import { createRuntimeModelStatusAccess } from './model-status-store.js';
import { memoryScopeForConversationKind } from './group-run-context.js';
import { getGroupBrowserStatus } from './group-browser-status.js';
import {
  handleFailure,
  resetGroupStreamingForTurn,
  waitOutput,
} from './group-processing-flow.js';
import {
  createAdvanceCursorHandler,
  createArchiveCurrentSessionHandler,
  createSaveProcedureHandler,
  createSenderCommandPolicy,
} from './group-session-command-state.js';
import { groupTurnHasRequiredTrigger } from './group-trigger-policy.js';
import {
  createResponseProgressSenders,
  sendInitialGroupProgress,
  startGroupProgressHeartbeats,
} from './group-progress-heartbeats.js';
import { createGroupAgentRunner } from './group-agent-runner.js';
import { buildMemoryRecallQueryFromMessages } from '../memory/app-memory-recall-query.js';
import { redactProviderSessionHandlesInText } from '../shared/provider-session-redaction.js';
let streamingGenerationCounter = 0;

export function createGroupProcessor(deps: GroupProcessingDeps) {
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
  const runAgent = createGroupAgentRunner({ deps, ops });

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
      triggerPattern: getTriggerPattern(group.trigger),
    });
    const cmdResult = await handleSessionCommand({
      missedMessages,
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
          memoryUserId,
          collectMemory: collectSessionMemory,
        }),
        clearCurrentSession: () =>
          deps.clearSession(group.folder, activeThreadId, {
            conversationJid: chatJid,
            conversationKind: group.conversationKind,
            memoryUserId,
          }),
        stopCurrentRun: () => deps.queue.stopGroup?.(queueJid) ?? false,
        runMemoryDreaming: () =>
          runDreamingForGroup({
            folder: group.folder,
            conversationId: chatJid,
            userId: memoryUserId,
            activeThreadId,
            defaultScope: defaultMemoryScope,
          }),
        getMemoryStatus: async () => {
          const memory = getRuntimeSettingsForConfig().memory;
          return getGroupMemoryStatus(
            {
              folder: group.folder,
              conversationId: chatJid,
              userId: memoryUserId,
              threadId: activeThreadId,
              defaultScope: defaultMemoryScope,
            },
            {
              embeddings:
                memory.enabled &&
                memory.embeddings.enabled &&
                memory.embeddings.provider !== 'disabled'
                  ? 'configured'
                  : 'disabled',
            },
          );
        },
        saveProcedure: createSaveProcedureHandler({
          folder: group.folder,
          conversationId: chatJid,
          userId: memoryUserId,
          defaultScope: defaultMemoryScope,
          threadId: activeThreadId,
          isAdminWrite: true,
        }),
        ...senderCommandPolicy,
      },
    });
    if (cmdResult.handled) return cmdResult.success;

    if (
      !groupTurnHasRequiredTrigger({
        group,
        chatJid,
        triggerPattern: getTriggerPattern(group.trigger),
        messages: missedMessages,
      })
    )
      return true;

    const prompt = formatMessages(missedMessages, TIMEZONE);
    const recallQuery = buildMemoryRecallQueryFromMessages(missedMessages);
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
    resetGroupStreamingForTurn({
      chatJid,
      groupName: group.name,
      channelRuntime: deps.channelRuntime,
      logger,
    });
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
    let typingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const supportsProgress = deps.channelRuntime.supportsProgress(chatJid);
    const sendDoneProgress = async (state: FinalProgressState) =>
      sendFinalProgressUpdate({
        enabled: supportsProgress,
        state,
        elapsed: formatElapsed(Date.now() - startedAt),
        options: buildDoneProgressOptions(activeThreadId, true),
        send: sendProgressToChannel,
      });
    const { sendWaitingProgress, sendResponseReceipt } =
      createResponseProgressSenders({
        supportsProgress,
        activeThreadId,
        buildMessageOptions,
        sendMessageToChannel,
        sendProgressToChannel,
      });
    await sendInitialGroupProgress({
      supportsProgress,
      groupName: group.name,
      buildMessageOptions,
      sendProgressToChannel,
      log: logger,
    });
    ({ typingHeartbeatTimer, progressTimer } = startGroupProgressHeartbeats({
      supportsProgress,
      isTypingActive: () => typingActive,
      getLastAgentProgressAt: () => lastAgentProgressAt,
      startedAt,
      chatJid,
      groupName: group.name,
      channelRuntime: deps.channelRuntime,
      buildMessageOptions,
      sendProgressToChannel,
      log: logger,
    }));
    let hadError = false;
    let outputSentToUser = false;
    const userVisibleTranscript = createRuntimeResultSummaryAccumulator();
    let streamedTranscriptDeliveryStatus: 'none' | 'sent' | 'partially_sent' =
      'none';
    let sawRawOutput = false;
    let pendingIdleBoundary = false;
    let sawDeliveryIncomplete = false;
    let sawTerminalDeliveryFailure = false;
    let awaitingResponseReceipt = false;
    let outputCallbackError: unknown;
    const supportsStreamingChunks =
      deps.channelRuntime.supportsStreaming(chatJid);
    const streamingOutput = createStreamingOutputState({
      enabled: supportsStreamingChunks,
      finalizeChunk: async (reason) => {
        const settlement = await settleDeliveryAttempt(
          () =>
            deps.channelRuntime.sendStreamingChunk(
              chatJid,
              '',
              buildStreamingOptions({ done: true }),
            ),
          { scope: 'runtime-streaming-finalize', target: chatJid },
        ).catch((err) => {
          logger.warn(
            { err, group: group.name, reason },
            'Failed to finalize streaming output',
          );
          return 'not_delivered' as const;
        });
        applyDeliverySettlement(settlement, { streamed: true, terminal: true });
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
    const applyDeliverySettlement = (
      settlement: Awaited<ReturnType<typeof settleDeliveryAttempt>>,
      options: { streamed: boolean; terminal: boolean },
    ) => {
      if (settlement === 'not_delivered') {
        if (options.terminal) {
          sawTerminalDeliveryFailure = true;
          if (options.streamed && streamedTranscriptDeliveryStatus === 'sent') {
            streamedTranscriptDeliveryStatus = 'partially_sent';
          }
        }
        return;
      }
      outputSentToUser = true;
      if (options.streamed) {
        if (settlement === 'delivery_incomplete') {
          streamedTranscriptDeliveryStatus = 'partially_sent';
        } else if (streamedTranscriptDeliveryStatus === 'none') {
          streamedTranscriptDeliveryStatus = 'sent';
        }
      }
      if (settlement === 'delivery_incomplete') sawDeliveryIncomplete = true;
    };
    let output: 'success' | 'error' = 'error';
    const handleAgentOutput = async (result: AgentOutput) => {
      lastAgentProgressAt = Date.now();
      if (awaitingResponseReceipt && !result.interactionBoundary) {
        awaitingResponseReceipt = false;
        await sendResponseReceipt();
      }
      if (result.result) {
        if (!typingActive) {
          await setTypingState(true);
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const safeRaw = redactProviderSessionHandlesInText(raw);
        sawRawOutput = true;
        pendingIdleBoundary = true;
        const text = formatOutboundForChannel(safeRaw);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          if (supportsStreamingChunks) {
            streamingOutput.markContent();
            const settlement = await settleDeliveryAttempt(
              () =>
                deps.channelRuntime.sendStreamingChunk(
                  chatJid,
                  safeRaw,
                  buildStreamingOptions({}),
                ),
              { scope: 'runtime-streaming-output', target: chatJid },
            );
            applyDeliverySettlement(settlement, {
              streamed: true,
              terminal: false,
            });
          } else {
            const messageOptions = await buildMessageOptions();
            const settlement = await settleDeliveryAttempt(
              () => sendMessageToChannel(text, messageOptions),
              { scope: 'runtime-output-message', target: chatJid },
            );
            applyDeliverySettlement(settlement, {
              streamed: false,
              terminal: false,
            });
          }
          userVisibleTranscript.append(`${text}\n`);
        }
        resetIdleTimer();
      }

      if (result.interactionBoundary) {
        pendingIdleBoundary = true;
        await finalizeStreamingOutput('interaction-boundary');
        startNextStreamingMessage();
        await sendWaitingProgress();
        await setTypingState(false);
        awaitingResponseReceipt = true;
        resetIdleTimer();
      }

      if (isAgentTurnCompleteMarker(result)) {
        await finalizeStreamingOutput('success-marker');
        notifyTurnIdle();
        startNextStreamingMessage();
        await setTypingState(false);
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
        await finalizeStreamingOutput('error-marker');
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
            recallQuery,
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
      if (idleTimer) clearTimeout(idleTimer);
    }

    let resultOk = true;
    if (output === 'error' || hadError) {
      resultOk = await handleFailure({
        outputSentToUser,
        groupName: group.name,
        queueJid,
        previousCursor,
        deps,
        logger,
      });
    } else {
      const finalization = await finalizeGroupAgentUserVisibleOutput({
        streamedTranscriptDeliveryStatus,
        boundedTranscript: userVisibleTranscript.snapshot(),
        chatJid,
        activeThreadId,
        outputSentToUser,
        sawRawOutput,
        groupName: group.name,
        warn: (metadata, message) => logger.warn(metadata, message),
        storeMessage: (message) => ops().storeMessage(message),
        buildMessageOptions,
        sendMessageToChannel: async (text, options) =>
          settleDeliveryAttempt(() => sendMessageToChannel(text, options), {
            scope: 'runtime-final-output-fallback',
            target: chatJid,
          }).catch((err) => {
            logger.warn(
              { err, group: group.name },
              'Failed to settle fallback output delivery',
            );
            return 'not_delivered' as const;
          }),
      });
      outputSentToUser = finalization.outputSentToUser;
      applyDeliverySettlement(finalization.terminalSettlement, {
        streamed: false,
        terminal: true,
      });
    }

    const finalProgressState: FinalProgressState =
      output === 'error' || hadError
        ? 'failed'
        : sawDeliveryIncomplete ||
            (sawTerminalDeliveryFailure && outputSentToUser)
          ? 'delivery_incomplete'
          : sawTerminalDeliveryFailure
            ? 'failed'
            : 'completed';
    await sendDoneProgress(finalProgressState);
    await setTypingState(false);
    return resultOk;
  }

  return { processGroupMessages };
}
