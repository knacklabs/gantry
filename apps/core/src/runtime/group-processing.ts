import * as config from '../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import { MessageSendOptions } from '../domain/types.js';
import * as agentOutputCallbacks from './agent-output-callbacks.js';
import * as progress from './progress-updates.js';
import { finalizeGroupAgentUserVisibleOutput } from './group-output-finalization.js';
import { formatMessages } from '../messaging/router.js';
import type { AgentOutput } from './agent-spawn.js';
import { handleSessionCommand } from '../session/session-commands.js';
import type {
  GroupProcessOptions,
  GroupProcessingDeps,
} from './group-processing-types.js';
import { getGroupMemoryStatus } from './group-memory-commands.js';
import { runDreamingForGroup } from './memory-dreaming-runner.js';
import { settleDeliveryAttempt } from '../jobs/delivery.js';
import { resolveMemoryUserId } from './session-resume-runtime.js';
import { firstThreadQueueId } from '../shared/thread-queue-key.js';
import { createRuntimeModelStatusAccess } from './model-status-store.js';
import { getConfiguredModelProvidersForApp } from '../adapters/storage/postgres/runtime-store.js';
import { resolveGroupProcessingRouteContext } from './command-override-route-key.js';
import { memoryScopeForConversationKind } from './group-run-context.js';
import { createGroupProcessingPersonResolver } from './group-person-identity.js';
import { getGroupBrowserStatus } from './group-browser-status.js';
import {
  handleFailure,
  resetGroupStreamingForTurn,
  resolveGroupTurnFinalProgressState,
  shouldSendTurnFinalProgress,
  waitOutput,
} from './group-processing-flow.js';
import {
  createAdvanceCursorHandler,
  createSaveProcedureHandler,
  createSenderCommandPolicy,
} from './group-session-command-state.js';
import { groupTurnHasRequiredTrigger } from './group-trigger-policy.js';
import {
  createResponseProgressSenders,
  startInitialGroupProgress,
  startGroupProgressHeartbeats,
} from './group-progress-heartbeats.js';
import { createProgressChannelSender } from './group-progress-channel-sender.js';
import { createGroupAgentRunner } from './group-agent-runner.js';
import type { GroupAgentRunResult } from './group-agent-runner.js';
import { createSessionCommandAgentRunners } from './group-session-command-runner.js';
import {
  isModelAccessAuthFailure,
  sendModelAccessAuthFailureNotice,
} from './model-access-auth-failure.js';
import { createGroupTurnOptionBuilders } from './group-turn-options.js';
import { collectPendingMessagesSince } from './pending-message-replay.js';
import { buildGroupProcessingConversationContext } from './group-processing-context.js';
import { createGroupOutputBuffer } from './group-output-buffer.js';
import { activeTurnUiCleanupByQueue } from './group-active-turn-cleanup.js';
import { createGroupProcessingSessionCommandHandlers } from './group-processing-session-command-handlers.js';
let streamingGenerationCounter = 0;
const PERMISSION_BACKGROUND_DEMOTE_MS = 120_000;
type ProgressHeartbeat = ReturnType<typeof startGroupProgressHeartbeats>;
export function createGroupProcessor(deps: GroupProcessingDeps) {
  const collectSessionMemory = deps.collectSessionMemory;
  const ops = () => {
    const repository = deps.opsRepository ?? deps.getRuntimeRepository?.();
    if (!repository)
      throw new Error('Group processor requires runtime repositories');
    return repository;
  };
  const runAgent = createGroupAgentRunner({ deps, ops });
  async function processGroupMessages(
    queueJid: string,
    options: GroupProcessOptions = {},
  ): Promise<boolean> {
    const routeContext = resolveGroupProcessingRouteContext(deps, queueJid);
    if (!routeContext) return true;
    const { chatJid, threadId, turnAppId, group } = routeContext;
    const { commandOverrideRouteKey } = routeContext;
    const channelAccount = group.providerAccountId
      ? { providerAccountId: group.providerAccountId }
      : undefined;
    if (!deps.channelRuntime.hasChannel(chatJid, channelAccount)) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }
    const scopedQueue = options.queued === true || threadId !== undefined;
    const opsRepository = ops();
    const replay = await collectPendingMessagesSince({
      getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
      chatJid,
      sinceCursor: await deps.getCursor(queueJid),
      pageSize: config.MESSAGE_FETCH_PAGE_SIZE,
      maxMessages: config.MAX_MESSAGES_PER_PROMPT,
      options: {
        ...(scopedQueue ? { threadId: threadId ?? null } : {}),
        ...(group.providerAccountId
          ? { providerAccountId: group.providerAccountId }
          : {}),
      },
    });
    const { messages: missedMessages } = replay;
    if (missedMessages.length === 0) return true;
    const latestMessage = missedMessages[missedMessages.length - 1];
    const cursorForMessage = (message: typeof latestMessage) =>
      encodeGroupMessageCursor(toGroupMessageCursor(message));
    const latestMessageReactionRef =
      latestMessage.external_message_id &&
      !latestMessage.external_message_id.startsWith('external-ingress:')
        ? latestMessage.external_message_id
        : null;
    const activeThreadId = firstThreadQueueId(
      threadId,
      latestMessage.thread_id,
    );
    let firstProgressNotified = false;
    const notifyFirstProgress = async () => {
      if (firstProgressNotified || !latestMessageReactionRef) return;
      firstProgressNotified = true;
      await options
        .onFirstProgress?.({
          jid: chatJid,
          messageRef: latestMessageReactionRef,
        })
        ?.catch(() => undefined);
    };
    let streamGeneration = (streamingGenerationCounter += 1);
    let progressGeneration = streamGeneration;
    const turnOptions = createGroupTurnOptionBuilders({
      activeThreadId,
      providerAccountId: group.providerAccountId,
      streamGeneration: () => streamGeneration,
      progressGeneration: () => progressGeneration,
    });
    const { buildMessageOptions, buildStreamingOptions, buildProgressOptions } =
      turnOptions;
    const setTurnTyping = (isTyping: boolean) =>
      channelAccount
        ? deps.channelRuntime.setTyping(chatJid, isTyping, channelAccount)
        : deps.channelRuntime.setTyping(chatJid, isTyping);
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
    const defaultMemoryScope = memoryScopeForConversationKind(
      group.conversationKind,
    );
    const rawMemoryUserId =
      options.memoryContext?.userId ?? resolveMemoryUserId(missedMessages);
    const resolveActionMemoryUserId = createGroupProcessingPersonResolver({
      deps,
      appId: turnAppId,
      rawUserId: rawMemoryUserId,
      group,
      messages: missedMessages,
      chatJid,
      threadId: activeThreadId,
    });
    const modelStatus = createRuntimeModelStatusAccess(
      group.folder,
      activeThreadId,
    );
    const senderCommandPolicy = createSenderCommandPolicy({
      chatJid,
      group,
      triggerPattern: config.getTriggerPattern(group.trigger),
    });
    const cmdResult = await handleSessionCommand({
      missedMessages,
      groupName: group.name,
      triggerPattern: config.getTriggerPattern(group.trigger),
      timezone: config.TIMEZONE,
      deps: {
        sendMessage: (text, options) =>
          sendMessageToChannel(text, buildMessageOptions(options?.threadId)),
        setTyping: setTurnTyping,
        ...createSessionCommandAgentRunners({
          runAgent,
          group,
          chatJid,
          queueJid,
          memoryUserId: resolveActionMemoryUserId,
          activeThreadId,
          missedMessages,
          existingRunId: options.existingRunId,
          existingRunLeaseToken: options.existingRunLeaseToken,
          existingRunLeaseWorkerInstanceId:
            options.existingRunLeaseWorkerInstanceId,
          existingRunLeaseFencingVersion:
            options.existingRunLeaseFencingVersion,
        }),
        closeStdin: () => deps.queue.closeStdin(queueJid),
        compactionScopeKey: queueJid,
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
          config.getDefaultModelConfig('interactive', group.folder).model,
        getJobModelDefaults: () => ({
          oneTime: config.getDefaultModelConfig('oneTimeJob', group.folder)
            .model,
          recurring: config.getDefaultModelConfig('recurringJob', group.folder)
            .model,
        }),
        getConfiguredModelProviders: () =>
          getConfiguredModelProvidersForApp(turnAppId),
        getModelFamilyOrder: () =>
          config.getRuntimeSettingsForConfig().modelFamilies,
        getGroupModelOverride: () => group.agentConfig?.model,
        setGroupModelOverride: async (value) =>
          deps.setGroupModelOverride(commandOverrideRouteKey, value),
        getModelStatus: modelStatus.getStatus,
        getBrowserStatus: () => getGroupBrowserStatus({ group, chatJid }),
        updateModelStatusSelection: modelStatus.updateSelection,
        getGroupThinkingOverride: () => group.agentConfig?.thinking,
        setGroupThinkingOverride: (value) =>
          deps.setGroupThinkingOverride(commandOverrideRouteKey, value),
        getGroupPermissionModeOverride: () => group.agentConfig?.permissionMode,
        getDefaultPermissionMode: () =>
          config.getSelectedAgentPermissionMode(group.folder),
        setGroupPermissionModeOverride: (value) =>
          deps.setGroupPermissionModeOverride(commandOverrideRouteKey, value),
        ...createGroupProcessingSessionCommandHandlers({
          ops,
          appId: turnAppId,
          defaultModel: config.getDefaultModelConfig(
            'interactive',
            group.folder,
          ).model,
          group,
          chatJid,
          threadId: activeThreadId ?? null,
          defaultScope: defaultMemoryScope,
          memoryUserId: resolveActionMemoryUserId,
          collectMemory: collectSessionMemory,
          deps,
        }),
        clearCurrentSession: async () =>
          deps.clearSession(group.folder, activeThreadId, {
            appId: turnAppId,
            conversationJid: chatJid,
            providerAccountId: group.providerAccountId,
            conversationKind: group.conversationKind,
            memoryUserId: await resolveActionMemoryUserId(),
          }),
        stopCurrentRun: () => deps.queue.stopGroup?.(queueJid) ?? false,
        runMemoryDreaming: async () =>
          runDreamingForGroup({
            folder: group.folder,
            conversationId: chatJid,
            userId: await resolveActionMemoryUserId(),
            activeThreadId,
            defaultScope: defaultMemoryScope,
          }),
        getMemoryStatus: async () => {
          const memoryUserId = await resolveActionMemoryUserId();
          const memory = config.getRuntimeSettingsForConfig().memory;
          return getGroupMemoryStatus(
            {
              folder: group.folder,
              conversationId: chatJid,
              userId: memoryUserId,
              threadId: activeThreadId,
              defaultScope: defaultMemoryScope,
            },
            {
              memoryEnabled: memory.enabled,
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
          userId: resolveActionMemoryUserId,
          defaultScope: defaultMemoryScope,
          threadId: activeThreadId,
          isAdminWrite: true,
        }),
        ...senderCommandPolicy,
      },
    });
    if (cmdResult.handled) {
      if (replay.hasMore) deps.queue.enqueueMessageCheck(queueJid);
      return cmdResult.success;
    }
    if (
      !groupTurnHasRequiredTrigger({
        group,
        chatJid,
        triggerPattern: config.getTriggerPattern(group.trigger),
        messages: missedMessages,
      })
    ) {
      deps.setCursor(queueJid, cursorForMessage(latestMessage));
      await deps.saveState();
      if (replay.hasMore) deps.queue.enqueueMessageCheck(queueJid);
      return true;
    }
    await notifyFirstProgress();
    const memoryUserId = await resolveActionMemoryUserId();
    const { prompt, recallQuery } =
      await buildGroupProcessingConversationContext({
        deps,
        repository: opsRepository,
        groupName: group.name,
        agentFolder: group.folder,
        chatJid,
        providerAccountId: group.providerAccountId,
        activeThreadId,
        latestMessage,
        currentMessages: missedMessages,
        timezone: config.TIMEZONE,
      });
    const previousCursor = (await deps.getCursor(queueJid)) || '';
    deps.setCursor(
      queueJid,
      cursorForMessage(missedMessages[missedMessages.length - 1]),
    );
    await deps.saveState();
    resetGroupStreamingForTurn({
      chatJid,
      groupName: group.name,
      channelRuntime: deps.channelRuntime,
      providerAccountId: group.providerAccountId,
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
      }, config.IDLE_TIMEOUT);
    };
    resetIdleTimer();
    let typingActive = false;
    const setTypingState = (isTyping: boolean) => (
      (typingActive = isTyping),
      setTurnTyping(isTyping)
    );
    await setTypingState(true);
    let progressPaused = false;
    let typingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let progressHeartbeat: ProgressHeartbeat | null = null;
    let backgroundDemoteTimer: ReturnType<typeof setTimeout> | null = null;
    let backgroundDemoted = false;
    const turnUiToken = Symbol(queueJid);
    const supportsProgress = deps.channelRuntime.supportsProgress(
      chatJid,
      channelAccount,
    );
    const sendControlOnlyProgress = async () => {
      if (!supportsProgress) return;
      await sendProgressToChannel('', {
        ...buildProgressOptions(),
        actionOnly: true,
      }).catch(() => undefined);
    };
    const sendRunningProgress = async () => {
      await sendControlOnlyProgress();
      await notifyFirstProgress();
    };
    const sendDoneProgress = async (state: progress.FinalProgressState) => {
      if (!supportsProgress) return;
      const generation = progressGeneration;
      finalizingProgressGenerations.add(generation);
      await progress.sendFinalProgressUpdate({
        enabled: true,
        state,
        options: buildProgressOptions({ done: true }),
        send: sendProgressToChannel,
        onError: (err) =>
          logger.warn(
            { err, chatJid, group: group.name },
            'Progress lifecycle final failed',
          ),
      });
    };
    let activeGenerationHasOutput = false;
    let sentAnyTurnDoneProgress = false;
    let sentTurnDoneProgressGeneration: number | null = null;
    const sendTrackedDoneProgress = async (
      state: progress.FinalProgressState,
    ) => {
      const generation = progressGeneration;
      await sendDoneProgress(state);
      if (supportsProgress) {
        sentAnyTurnDoneProgress = true;
        sentTurnDoneProgressGeneration = generation;
      }
    };
    let userVisibleTurnProgressReady: Promise<void> | null = null;
    const startUserVisibleTurn = async () => {
      progressGeneration = streamGeneration = streamingGenerationCounter += 1;
      activeGenerationHasOutput = false;
      sentAnyTurnDoneProgress = false;
      sentTurnDoneProgressGeneration = null;
      progressPaused = false;
      typingActive = true;
      progressHeartbeat?.resume();
      void setTurnTyping(true).catch((err) =>
        logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
      );
      const progressReady = sendRunningProgress().finally(() => {
        if (userVisibleTurnProgressReady === progressReady) {
          userVisibleTurnProgressReady = null;
        }
      });
      userVisibleTurnProgressReady = progressReady;
      await progressReady;
    };
    const sendWaitingForUserResponseProgress = async () => {
      if (!supportsProgress) return;
      await sendProgressToChannel(
        'Waiting for your input.',
        buildProgressOptions({ replaceOnly: true }),
      ).catch(() => undefined);
    };
    const { sendResponseReceipt } = createResponseProgressSenders({
      supportsProgress,
      activeThreadId,
      progressGeneration: () => progressGeneration,
      buildMessageOptions,
      sendMessageToChannel,
      sendProgressToChannel,
    });
    await options
      .onLiveStopActionToken?.(turnOptions.liveStopActionToken)
      ?.catch((err) =>
        logger.warn(
          { err, chatJid, group: group.name },
          'Failed to register live Stop action token before progress render',
        ),
      );
    void activeTurnUiCleanupByQueue.get(queueJid)?.cancel();
    activeTurnUiCleanupByQueue.delete(queueJid);
    const initialProgress = startInitialGroupProgress({
      supportsProgress,
      groupName: group.name,
      buildProgressOptions,
      sendProgressToChannel,
      onSent: notifyFirstProgress,
      log: logger,
    });
    progressHeartbeat = startGroupProgressHeartbeats({
      supportsProgress,
      isTypingActive: () => typingActive,
      chatJid,
      providerAccountId: group.providerAccountId,
      groupName: group.name,
      channelRuntime: deps.channelRuntime,
      log: logger,
    });
    typingHeartbeatTimer = progressHeartbeat.typingHeartbeatTimer;
    const unregisterContinuationHandler =
      deps.queue.registerContinuationHandler?.(queueJid, () => {
        void startUserVisibleTurn();
      });
    const cancelTurnUiTimers = async () => {
      if (typingHeartbeatTimer) {
        clearInterval(typingHeartbeatTimer);
        typingHeartbeatTimer = null;
      }
      clearBackgroundDemoteTimer();
      await initialProgress.cancel();
    };
    activeTurnUiCleanupByQueue.set(queueJid, {
      token: turnUiToken,
      cancel: cancelTurnUiTimers,
    });
    let hadError = false;
    let outputSentToUser = false;
    let streamedTranscriptDeliveryStatus: 'none' | 'sent' | 'partially_sent' =
      'none';
    let sawRawOutput = false;
    let pendingIdleBoundary = false;
    let sawDeliveryIncomplete = false;
    let sawTerminalDeliveryFailure = false;
    let awaitingResponseReceipt = false;
    let outputCallbackError: unknown;
    const supportsStreamingChunks = deps.channelRuntime.supportsStreaming(
      chatJid,
      channelAccount,
    );
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
    const pauseTurnProgress = async () => {
      if (progressPaused) return;
      progressPaused = true;
      progressHeartbeat?.pause();
      if (supportsProgress) {
        await sendWaitingForUserResponseProgress();
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
    const resumeTurnProgress = async () => {
      if (!progressPaused) return;
      progressPaused = false;
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
    const outputBuffer = createGroupOutputBuffer({
      channelRuntime: deps.channelRuntime,
      chatJid,
      groupName: group.name,
      supportsStreamingChunks,
      buildStreamingOptions,
      buildMessageOptions,
      sendMessageToChannel,
      applyDeliverySettlement,
      log: logger,
    });
    const finalizeStreamingOutput = outputBuffer.flushBufferedOutput;
    let output: GroupAgentRunResult = 'error';
    const handleAgentOutput = async (result: AgentOutput) => {
      const isTurnCompleteMarker =
        agentOutputCallbacks.isAgentTurnCompleteMarker(result);
      const wasAwaitingResponseReceipt = awaitingResponseReceipt;
      if (
        awaitingResponseReceipt &&
        !result.interactionBoundary &&
        !isTurnCompleteMarker
      ) {
        awaitingResponseReceipt = false;
        await resumeTurnProgress();
        startNextContentStream();
        await sendResponseReceipt();
      }
      if (result.result) {
        if (!typingActive) await setTypingState(true);
        activeGenerationHasOutput = true;
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        sawRawOutput = true;
        pendingIdleBoundary = true;
        await outputBuffer.appendRawOutput(raw);
        resetIdleTimer();
      }
      if (result.interactionBoundary) {
        pendingIdleBoundary = true;
        await finalizeStreamingOutput('interaction-boundary', {
          done: true,
          terminal: false,
        });
        await pauseTurnProgress();
        await setTypingState(false);
        awaitingResponseReceipt = true;
        resetIdleTimer();
      }
      if (isTurnCompleteMarker) {
        await finalizeStreamingOutput('success-marker');
        if (result.continuedByFollowup) {
          startNextContentStream();
          resetIdleTimer();
          return;
        }
        const markerProgressState = resolveGroupTurnFinalProgressState({
          output: 'success',
          hadError,
          sawDeliveryIncomplete,
          sawTerminalDeliveryFailure,
          outputSentToUser,
        });
        if (
          shouldSendTurnFinalProgress({
            finalProgressState: markerProgressState,
            awaitingResponseReceipt:
              wasAwaitingResponseReceipt || awaitingResponseReceipt,
            sentAnyTurnDoneProgress,
            activeGenerationHasOutput,
            sentTurnDoneProgressGeneration,
            progressGeneration,
          })
        ) {
          await sendTrackedDoneProgress(markerProgressState);
        }
        if (typingActive) await setTypingState(false);
        startNextStreamingMessage();
        resetIdleTimer();
      }
      if (result.status === 'error') {
        hadError = true;
        await resumeTurnProgress();
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
    const outputCallbacks =
      agentOutputCallbacks.createSerializedAgentOutputCallbacks({
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
          existingRunId: options.existingRunId,
          existingRunLeaseToken: options.existingRunLeaseToken,
          existingRunLeaseWorkerInstanceId:
            options.existingRunLeaseWorkerInstanceId,
          existingRunLeaseFencingVersion:
            options.existingRunLeaseFencingVersion,
          liveStopActionToken: turnOptions.liveStopActionToken,
          responseSchema: replay.responseSchema,
          agentControls: replay.agentControls,
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
      await resumeTurnProgress();
      if (output === 'success' && pendingIdleBoundary) {
        notifyTurnIdle();
      }
      await cancelTurnUiTimers();
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
        acknowledgeFailedTurn:
          options.finalRetry === true && !deps.queue.isShuttingDown?.(),
        logger,
      });
    } else {
      const finalization = await finalizeGroupAgentUserVisibleOutput({
        streamedTranscriptDeliveryStatus,
        boundedTranscript: outputBuffer.transcriptSnapshot(),
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
    const finalProgressState = resolveGroupTurnFinalProgressState({
      output,
      hadError,
      sawDeliveryIncomplete,
      sawTerminalDeliveryFailure,
      outputSentToUser,
    });
    if (
      shouldSendTurnFinalProgress({
        finalProgressState,
        awaitingResponseReceipt,
        sentAnyTurnDoneProgress,
        activeGenerationHasOutput,
        sentTurnDoneProgressGeneration,
        progressGeneration,
      })
    ) {
      await sendTrackedDoneProgress(finalProgressState);
    }
    await setTypingState(false);
    if (resultOk && replay.hasMore) deps.queue.enqueueMessageCheck(queueJid);
    options?.onRunResult?.(output);
    return resultOk;
  }
  return { processGroupMessages };
}
