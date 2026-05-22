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
  createRuntimeUserVisibleResultAccumulator,
  createRuntimeUserVisibleStreamSanitizer,
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
  createSaveProcedureHandler,
  createSenderCommandPolicy,
  createSessionArchiveHandlers,
} from './group-session-command-state.js';
import { groupTurnHasRequiredTrigger } from './group-trigger-policy.js';
import {
  createResponseProgressSenders,
  startInitialGroupProgress,
  startGroupProgressHeartbeats,
} from './group-progress-heartbeats.js';
import { createProgressChannelSender } from './group-progress-channel-sender.js';
import { createGroupAgentRunner } from './group-agent-runner.js';
import { buildMemoryRecallQueryFromMessages } from '../memory/app-memory-recall-query.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import {
  isModelAccessAuthFailure,
  sendModelAccessAuthFailureNotice,
} from './model-access-auth-failure.js';
let streamingGenerationCounter = 0;
const PERMISSION_BACKGROUND_DEMOTE_MS = 120_000;
type ProgressHeartbeat = ReturnType<typeof startGroupProgressHeartbeats>;
type ActiveTurnUiCleanup = { token: symbol; cancel: () => void };
const activeTurnUiCleanupByQueue = new Map<string, ActiveTurnUiCleanup>();

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
    let progressGeneration = streamGeneration;
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
    const buildProgressOptions = (
      args: { threadId?: string; done?: boolean; replaceOnly?: boolean } = {},
    ): ProgressUpdateOptions => ({
      ...(resolveThreadId(args.threadId)
        ? { threadId: resolveThreadId(args.threadId) }
        : {}),
      generation: progressGeneration,
      ...(args.done !== undefined ? { done: args.done } : {}),
      ...(args.replaceOnly !== undefined
        ? { replaceOnly: args.replaceOnly }
        : {}),
    });
    const sendMessageToChannel = async (
      text: string,
      options?: MessageSendOptions,
    ): Promise<void> =>
      void (await (options
        ? deps.channelRuntime.sendMessage(chatJid, text, options)
        : deps.channelRuntime.sendMessage(chatJid, text)));
    const finalizingProgressGenerations = new Set<number>();
    const sendProgressToChannel = createProgressChannelSender({
      channelRuntime: deps.channelRuntime,
      chatJid,
      groupName: group.name,
      finalizingGenerations: finalizingProgressGenerations,
      log: logger,
    });
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
            turnMessages: missedMessages,
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
        ...createSessionArchiveHandlers({
          ops,
          group,
          chatJid,
          threadId: activeThreadId ?? null,
          defaultScope: defaultMemoryScope,
          memoryUserId,
          collectMemory: collectSessionMemory,
          executionAdapter: deps.executionAdapter,
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
    const setTypingState = (isTyping: boolean) => (
      (typingActive = isTyping),
      deps.channelRuntime.setTyping(chatJid, isTyping)
    );
    await setTypingState(true);
    let startedAt = currentTimeMs();
    let pausedAt: number | null = null;
    let pausedTotalMs = 0;
    const activeElapsedMs = () =>
      currentTimeMs() -
      startedAt -
      pausedTotalMs -
      (pausedAt === null ? 0 : currentTimeMs() - pausedAt);
    let lastAgentProgressAt = startedAt;
    let typingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let progressHeartbeat: ProgressHeartbeat | null = null;
    const resetActiveElapsed = () => {
      startedAt = currentTimeMs();
      pausedAt = null;
      pausedTotalMs = 0;
      lastAgentProgressAt = startedAt;
      progressHeartbeat?.reset();
    };
    let backgroundDemoteTimer: ReturnType<typeof setTimeout> | null = null;
    let backgroundDemoted = false;
    const turnUiToken = Symbol(queueJid);
    const supportsProgress = deps.channelRuntime.supportsProgress(chatJid);
    const sendDoneProgress = async (state: FinalProgressState) => {
      finalizingProgressGenerations.add(progressGeneration);
      await sendFinalProgressUpdate({
        enabled: supportsProgress,
        state,
        elapsed: formatElapsed(activeElapsedMs()),
        options: buildDoneProgressOptions(
          activeThreadId,
          false,
          progressGeneration,
        ),
        send: sendProgressToChannel,
        onError: (err) =>
          logger.warn(
            { err, chatJid, group: group.name, state },
            'Progress lifecycle final failed',
          ),
      });
    };
    let activeGenerationHasOutput = false;
    let sentAnyTurnDoneProgress = false;
    let sentTurnDoneProgressGeneration: number | null = null;
    const sendTurnDoneProgress = async (state: FinalProgressState) => {
      if (
        !activeGenerationHasOutput ||
        sentTurnDoneProgressGeneration === progressGeneration
      ) {
        return;
      }
      sentTurnDoneProgressGeneration = progressGeneration;
      sentAnyTurnDoneProgress = true;
      await sendDoneProgress(state);
    };
    const startUserVisibleTurn = () => {
      progressGeneration = streamGeneration = streamingGenerationCounter += 1;
      activeGenerationHasOutput = false;
      resetActiveElapsed();
      typingActive = true;
      progressHeartbeat?.resume();
      void deps.channelRuntime
        .setTyping(chatJid, true)
        .catch((err) =>
          logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
        );
      if (supportsProgress) {
        void sendProgressToChannel(
          'Working on it...',
          buildProgressOptions(),
        ).catch(() => undefined);
      }
    };
    const { sendResponseReceipt } = createResponseProgressSenders({
      supportsProgress,
      activeThreadId,
      progressGeneration: () => progressGeneration,
      buildMessageOptions,
      sendMessageToChannel,
      sendProgressToChannel,
    });
    activeTurnUiCleanupByQueue.get(queueJid)?.cancel();
    activeTurnUiCleanupByQueue.delete(queueJid);
    const initialProgress = startInitialGroupProgress({
      supportsProgress,
      groupName: group.name,
      buildMessageOptions,
      buildProgressOptions,
      sendProgressToChannel,
      log: logger,
    });
    progressHeartbeat = startGroupProgressHeartbeats({
      supportsProgress,
      isTypingActive: () => typingActive,
      getLastAgentProgressAt: () => lastAgentProgressAt,
      getElapsedMs: activeElapsedMs,
      chatJid,
      groupName: group.name,
      channelRuntime: deps.channelRuntime,
      buildMessageOptions,
      buildProgressOptions,
      sendProgressToChannel,
      log: logger,
    });
    ({ typingHeartbeatTimer, progressTimer } = progressHeartbeat);
    const unregisterContinuationHandler =
      deps.queue.registerContinuationHandler?.(queueJid, startUserVisibleTurn);
    const cancelTurnUiTimers = () => {
      if (typingHeartbeatTimer) {
        clearInterval(typingHeartbeatTimer);
        typingHeartbeatTimer = null;
      }
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      clearBackgroundDemoteTimer();
      void initialProgress.cancel();
    };
    activeTurnUiCleanupByQueue.set(queueJid, {
      token: turnUiToken,
      cancel: cancelTurnUiTimers,
    });
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
    let pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
    let streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
    let pendingOutputRawChars = 0;
    let pendingOutputHasParts = false;
    const flushBufferedOutput = async (
      reason: string,
      options: { done?: boolean; terminal?: boolean } = {},
    ) => {
      if (!pendingOutputHasParts) return false;
      const done = options.done ?? true;
      const terminal = options.terminal ?? true;
      const visibleOutput = pendingOutputVisible.snapshot();
      const finalStreamDelta = streamSanitizer.finish();
      const rawChars = pendingOutputRawChars;
      pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
      streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
      pendingOutputRawChars = 0;
      pendingOutputHasParts = false;
      const text = visibleOutput ? formatOutboundForChannel(visibleOutput) : '';
      logger.info({ group: group.name }, `Agent output: ${rawChars} chars`);
      if (!text) return false;
      if (supportsStreamingChunks) {
        const settlement = await settleDeliveryAttempt(
          () =>
            deps.channelRuntime.sendStreamingChunk(
              chatJid,
              finalStreamDelta,
              buildStreamingOptions({ done }),
            ),
          { scope: 'runtime-streaming-output-final', target: chatJid },
        ).catch((err) => {
          logger.warn(
            { err, group: group.name, reason },
            'Failed to send finalized streaming output',
          );
          return 'not_delivered' as const;
        });
        applyDeliverySettlement(settlement, {
          streamed: true,
          terminal,
        });
      } else {
        const messageOptions = await buildMessageOptions();
        const settlement = await settleDeliveryAttempt(
          () => sendMessageToChannel(text, messageOptions),
          { scope: 'runtime-output-message-final', target: chatJid },
        );
        applyDeliverySettlement(settlement, {
          streamed: false,
          terminal,
        });
      }
      userVisibleTranscript.append(`${text}\n`);
      return true;
    };
    const finalizeStreamingOutput = flushBufferedOutput;
    const startNextStreamingMessage = () => {
      progressGeneration = streamGeneration = streamingGenerationCounter += 1;
      activeGenerationHasOutput = false;
    };
    const startNextContentStream = () => {
      streamGeneration = streamingGenerationCounter += 1;
      activeGenerationHasOutput = false;
    };
    const notifyTurnIdle = () => {
      deps.queue.notifyIdle(queueJid);
      pendingIdleBoundary = false;
    };
    const clearBackgroundDemoteTimer = () => {
      if (!backgroundDemoteTimer) return;
      clearTimeout(backgroundDemoteTimer);
      backgroundDemoteTimer = null;
    };
    const pauseActiveElapsed = async () => {
      if (pausedAt !== null) return;
      pausedAt = currentTimeMs();
      progressHeartbeat?.pause();
      if (supportsProgress) {
        await sendProgressToChannel(
          `Waiting for your response (${formatElapsed(activeElapsedMs())}).`,
          buildProgressOptions({ replaceOnly: true }),
        ).catch(() => undefined);
      }
      clearBackgroundDemoteTimer();
      backgroundDemoteTimer = setTimeout(() => {
        backgroundDemoted = true;
        void sendProgressToChannel(
          'Running in background...',
          buildProgressOptions({ done: true, replaceOnly: true }),
        ).catch(() => undefined);
      }, PERMISSION_BACKGROUND_DEMOTE_MS);
      backgroundDemoteTimer.unref?.();
    };
    const resumeActiveElapsed = async () => {
      if (pausedAt === null) return;
      pausedTotalMs += currentTimeMs() - pausedAt;
      pausedAt = null;
      clearBackgroundDemoteTimer();
      progressHeartbeat?.resume();
      if (backgroundDemoted) {
        startNextStreamingMessage();
        progressGeneration = streamGeneration;
        backgroundDemoted = false;
      }
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
      lastAgentProgressAt = currentTimeMs();
      if (awaitingResponseReceipt && !result.interactionBoundary) {
        awaitingResponseReceipt = false;
        await resumeActiveElapsed();
        startNextContentStream();
        await sendResponseReceipt();
      }
      if (result.result) {
        if (
          !typingActive &&
          sentAnyTurnDoneProgress &&
          !activeGenerationHasOutput
        )
          resetActiveElapsed();
        if (!typingActive) {
          await setTypingState(true);
        }
        activeGenerationHasOutput = true;
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        sawRawOutput = true;
        pendingIdleBoundary = true;
        pendingOutputHasParts = true;
        pendingOutputRawChars += raw.length;
        pendingOutputVisible.append(raw);
        if (supportsStreamingChunks) {
          const safeDelta = streamSanitizer.append(raw);
          const text = safeDelta;
          if (text) {
            const settlement = await settleDeliveryAttempt(
              () =>
                deps.channelRuntime.sendStreamingChunk(
                  chatJid,
                  text,
                  buildStreamingOptions({ done: false }),
                ),
              { scope: 'runtime-streaming-output-live', target: chatJid },
            );
            applyDeliverySettlement(settlement, {
              streamed: true,
              terminal: false,
            });
          }
        }
        resetIdleTimer();
      }

      if (result.interactionBoundary) {
        pendingIdleBoundary = true;
        await finalizeStreamingOutput('interaction-boundary', {
          done: true,
          terminal: false,
        });
        await pauseActiveElapsed();
        await setTypingState(false);
        awaitingResponseReceipt = true;
        resetIdleTimer();
      }

      if (isAgentTurnCompleteMarker(result)) {
        await finalizeStreamingOutput('success-marker');
        if (result.continuedByFollowup) {
          startNextContentStream();
          resetIdleTimer();
          return;
        }
        await sendTurnDoneProgress('completed');
        notifyTurnIdle();
        startNextStreamingMessage();
        await setTypingState(false);
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
        await resumeActiveElapsed();
        await finalizeStreamingOutput('error-marker');
        if (!outputSentToUser && isModelAccessAuthFailure(result.error)) {
          applyDeliverySettlement(
            await sendModelAccessAuthFailureNotice({
              chatJid,
              groupName: group.name,
              messageOptions: await buildMessageOptions(),
              sendMessageToChannel,
              warn: (metadata, message) => logger.warn(metadata, message),
            }),
            { streamed: false, terminal: true },
          );
        }
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
          turnMessages: missedMessages,
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
      await resumeActiveElapsed();
      if (output === 'success' && pendingIdleBoundary) {
        notifyTurnIdle();
      }
      cancelTurnUiTimers();
      unregisterContinuationHandler?.();
      const activeCleanup = activeTurnUiCleanupByQueue.get(queueJid);
      if (activeCleanup?.token === turnUiToken) {
        activeTurnUiCleanupByQueue.delete(queueJid);
      }
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
    if (
      finalProgressState !== 'completed' ||
      !sentAnyTurnDoneProgress ||
      (activeGenerationHasOutput &&
        sentTurnDoneProgressGeneration !== progressGeneration)
    ) {
      await sendDoneProgress(finalProgressState);
    }
    await setTypingState(false);
    return resultOk;
  }

  return { processGroupMessages };
}
