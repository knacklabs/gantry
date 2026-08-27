import * as config from '../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import { MessageSendOptions, NewMessage } from '../domain/types.js';
import * as agentOutputCallbacks from './agent-output-callbacks.js';
import * as progress from './progress-updates.js';
import { finalizeGroupAgentUserVisibleOutput } from './group-output-finalization.js';
import type { AgentOutput } from './agent-spawn.js';
import { handleSessionCommand } from '../session/session-commands.js';
import type {
  GroupProcessOptions,
  GroupProcessingDeps,
} from './group-processing-types.js';
import { settleDeliveryAttempt } from '../jobs/delivery.js';
import { resolveMemoryUserId } from './session-resume-runtime.js';
import { firstThreadQueueId } from '../shared/thread-queue-key.js';
import { getConfiguredModelProvidersForApp } from '../adapters/storage/postgres/runtime-store.js';
import { resolveGroupProcessingRouteContext } from './command-override-route-key.js';
import { memoryScopeForConversationKind } from './group-run-context.js';
import {
  detachTerminalCleanup,
  handleFailure,
  resetGroupStreamingForTurn,
  resolveGroupTurnFinalProgressState,
  shouldSendTurnFinalProgress,
  waitOutput,
} from './group-processing-flow.js';
import {
  createGroupDoneProgressSender,
  sendGroupFinalProgress,
} from './group-final-progress-action.js';
import { groupTurnHasRequiredTrigger } from './group-trigger-policy.js';
import {
  createResponseProgressSenders,
  startInitialGroupProgress,
} from './group-progress-heartbeats.js';
import {
  createGroupTurnTypingSender,
  startGroupLivenessHeartbeat,
} from './group-liveness-state.js';
import { createProgressChannelSender } from './group-progress-channel-sender.js';
import {
  createGroupAgentRunner,
  type GroupAgentRunResult,
} from './group-agent-runner.js';
import {
  isModelAccessAuthFailure,
  sendModelAccessAuthFailureNotice,
} from './model-access-auth-failure.js';
import { createGroupTurnOptionBuilders } from './group-turn-options.js';
import { collectPendingMessagesSince } from './pending-message-replay.js';
import { buildGroupProcessingConversationContext } from './group-processing-context.js';
import { createGroupOutputBuffer } from './group-output-buffer.js';
import { persistTurnAssistantTranscript } from './group-output-finalization.js';
import { activeTurnUiCleanupByQueue } from './group-active-turn-cleanup.js';
import { randomUUID } from 'node:crypto';
import { nowIso } from '../shared/time/datetime.js';
import { createGroupProcessingSessionCommandHandlers } from './group-processing-session-command-handlers.js';
import { createGroupProcessingPersonResolver } from './group-person-identity.js';
import {
  isFailoverEligibleError,
  isMissingProviderSessionError,
} from './failover-eligibility.js';
let streamingGenerationCounter = 0;
const PERMISSION_BACKGROUND_DEMOTE_MS = 120_000;
const PROVIDER_FAILOVER_EXHAUSTED_MESSAGE =
  "The AI provider is unavailable and your message couldn't be processed after several retries. Please try again shortly.";
type ProgressHeartbeat = ReturnType<typeof startGroupLivenessHeartbeat>;
function slackChannelRootThreadId(
  chatJid: string,
  externalMessageId: string | null | undefined,
): string | undefined {
  if (!/^sl:[CG][A-Z0-9]+$/i.test(chatJid)) return undefined;
  const threadId = externalMessageId?.trim();
  return /^\d+\.\d+$/.test(threadId ?? '') ? threadId : undefined;
}

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
    const replayCursor = await deps.getCursor(queueJid);
    const replay = await collectPendingMessagesSince({
      getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
      chatJid,
      sinceCursor: replayCursor,
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
      slackChannelRootThreadId(chatJid, latestMessage.external_message_id),
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
    const setTurnTyping = createGroupTurnTypingSender({
      channelRuntime: deps.channelRuntime,
      chatJid,
      providerAccountId: group.providerAccountId,
      activeThreadId,
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
      providerAccountId: group.providerAccountId,
      threadId: activeThreadId,
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
    const cmdResult = await handleSessionCommand({
      missedMessages,
      groupName: group.name,
      triggerPattern: config.getTriggerPattern(group.trigger),
      timezone: config.TIMEZONE,
      deps: createGroupProcessingSessionCommandHandlers({
        ops,
        appId: turnAppId,
        defaultModel: config.getDefaultModelConfig('interactive', group.folder)
          .model,
        group,
        chatJid,
        threadId: activeThreadId,
        defaultScope: defaultMemoryScope,
        memoryUserId: resolveActionMemoryUserId,
        collectMemory: collectSessionMemory,
        deps,
        queueJid,
        missedMessages,
        runAgent,
        processOptions: options,
        commandOverrideRouteKey,
        setTyping: setTurnTyping,
        sendMessage: sendMessageToChannel,
        buildMessageOptions,
        triggerPattern: config.getTriggerPattern(group.trigger),
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
        getDefaultPermissionMode: () =>
          config.getSelectedAgentPermissionMode(group.folder),
        getMemorySettings: () => config.getRuntimeSettingsForConfig().memory,
      }),
    });
    if (cmdResult.handled) {
      if (replay.hasMore) deps.queue.enqueueMessageCheck(queueJid);
      return (sendProgressToChannel.retire(), cmdResult.success);
    }
    if (
      !(await groupTurnHasRequiredTrigger({
        group,
        chatJid,
        triggerPattern: config.getTriggerPattern(group.trigger),
        messages: missedMessages,
        continuation: {
          threadId,
          hasPriorCursor: replayCursor.trim().length > 0,
          messageRepository: opsRepository,
          pageSize: config.MESSAGE_FETCH_PAGE_SIZE,
        },
      }))
    ) {
      deps.setCursor(queueJid, cursorForMessage(latestMessage));
      await deps.saveState();
      if (replay.hasMore) deps.queue.enqueueMessageCheck(queueJid);
      sendProgressToChannel.retire();
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
        conversationId: group.conversationId,
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
    const sendDoneProgress = createGroupDoneProgressSender({
      supportsProgress,
      pause: () => progressHeartbeat?.pause(),
      progressGeneration: () => progressGeneration,
      finalizingGenerations: finalizingProgressGenerations,
      buildOptions: () => buildProgressOptions({ done: true }),
      send: sendProgressToChannel,
      onError: (err) => logger.warn({ err, chatJid }, 'Final progress failed'),
    });
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
      progressHeartbeat?.resetStallEpoch();
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
    progressHeartbeat = startGroupLivenessHeartbeat({
      supportsProgress,
      isTypingActive: () => typingActive,
      chatJid,
      providerAccountId: group.providerAccountId,
      activeThreadId,
      groupName: group.name,
      buildProgressOptions,
      sendProgressToChannel,
      onFirstVisibleOutput: options.onFirstVisibleOutput,
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
      progressHeartbeat?.pause();
      await initialProgress.cancel();
    };
    activeTurnUiCleanupByQueue.set(queueJid, {
      token: turnUiToken,
      cancel: cancelTurnUiTimers,
    });
    let hadError = false;
    let lastAgentError: string | undefined;
    let outputSentToUser = false;
    const undeliveredGenerations: string[] = [];
    // A turn must leave exactly one durable assistant record. Per-generation
    // persistence is the primary path; this flag drives the finalization
    // safety net below so a turn whose output never reached a `done` flush
    // (transport-specific streaming paths do exist) is not left with the
    // reply visible to the user but absent from GET /messages.
    let persistedAnyGeneration = false;
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
      progressHeartbeat?.resetStallEpoch();
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
      allowIntentionalNoReply: group.requiresTrigger === false,
      // Release an intentional ambient no-reply without waiting for idle.
      onIntentionalNoReply: () => deps.queue.closeStdin(queueJid),
      buildStreamingOptions,
      buildMessageOptions,
      sendMessageToChannel,
      applyDeliverySettlement,
      onVisibleDeliveryStart: progressHeartbeat.beginVisibleDelivery,
      onVisibleDeliveryFinish: progressHeartbeat.finishVisibleOutputDelivery,
      getStreamedTranscriptDeliveryStatus: () =>
        streamedTranscriptDeliveryStatus,
      // Persistence is per completed generation, so the accounting has to be
      // too: otherwise a delivered generation leaves the status non-'none' and
      // a later, wholly undelivered one is persisted as if it had been sent.
      resetStreamedTranscriptDeliveryStatus: () => {
        streamedTranscriptDeliveryStatus = 'none';
      },
      onGenerationUndelivered: (text) => {
        undeliveredGenerations.push(text);
      },
      persistCompletedStreamedGeneration: async (text, deliveryStatus) => {
        persistedAnyGeneration = true;
        const timestamp = nowIso();
        const message: NewMessage = {
          id: `streamed-outbound:${randomUUID()}`,
          chat_jid: chatJid,
          sender: 'gantry',
          sender_name: 'Gantry',
          content: text.trim(),
          timestamp,
          is_from_me: true,
          is_bot_message: true,
          thread_id: activeThreadId,
          delivery_status: deliveryStatus,
          // Only claim a delivery time when something was actually delivered.
          delivered_at: deliveryStatus === 'failed' ? undefined : timestamp,
        };
        await ops()
          .storeMessage(message)
          .catch((err: unknown) =>
            logger.warn(
              { err, group: group.name },
              'Failed to persist streamed assistant generation',
            ),
          );
      },
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
        if (
          group.requiresTrigger === false &&
          !outputBuffer.intentionalNoReplyRequested()
        ) {
          deps.queue.closeStdin(queueJid);
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
        lastAgentError = result.error;
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
      detachTerminalCleanup(options.onTurnTerminal);
      unregisterContinuationHandler?.();
      const activeCleanup = activeTurnUiCleanupByQueue.get(queueJid);
      if (activeCleanup?.token === turnUiToken) {
        activeTurnUiCleanupByQueue.delete(queueJid);
      }
      if (idleTimer) clearTimeout(idleTimer);
    }
    let resultOk = true;
    if (output === 'error' || hadError) {
      // Provider infrastructure is exhausted only after the queue has burned
      // every retry; earlier failures keep the rollback-and-retry path.
      const failoverExhausted =
        options.finalRetry === true &&
        (isFailoverEligibleError(lastAgentError) ||
          isMissingProviderSessionError(lastAgentError));
      // ponytail: preserve the cursor only after the user sees the exhausted
      // notice. A failed notice rolls back; issue #285 owns durable re-drive.
      let failureNoticeDelivered = false;
      if (failoverExhausted && !outputSentToUser) {
        logger.error(
          { group: group.name, error: lastAgentError },
          'Provider failover exhausted after retries; dropping turn to stop replay storm, notifying user',
        );
        const noticeOptions = buildMessageOptions();
        const noticeSettlement = await settleDeliveryAttempt(
          () =>
            sendMessageToChannel(
              PROVIDER_FAILOVER_EXHAUSTED_MESSAGE,
              noticeOptions,
            ),
          {
            scope: 'runtime-provider-failover-exhausted',
            target: chatJid,
          },
        ).catch((err) => {
          logger.error(
            { err, group: group.name },
            'Failed to send provider failover exhausted notice',
          );
          return 'not_delivered' as const;
        });
        failureNoticeDelivered = noticeSettlement !== 'not_delivered';
        applyDeliverySettlement(noticeSettlement, {
          streamed: false,
          terminal: true,
        });
      }
      const userInformed = outputSentToUser || failureNoticeDelivered;
      resultOk = await handleFailure({
        outputSentToUser,
        groupName: group.name,
        queueJid,
        previousCursor,
        deps,
        acknowledgeFailedTurn:
          options.finalRetry === true &&
          !deps.queue.isShuttingDown?.() &&
          (!failoverExhausted || userInformed),
        preserveCursor: failoverExhausted && userInformed,
        logger,
      });
    } else {
      await persistTurnAssistantTranscript({
        supportsStreamingChunks,
        persistedAnyGeneration,
        transcript: outputBuffer.transcriptSnapshot(),
        chatJid,
        activeThreadId,
        outputSentToUser,
        groupName: group.name,
        storeMessage: (message) => ops().storeMessage(message),
        log: logger,
      });
      if (!outputBuffer.intentionalNoReplyRequested()) {
        const finalization = await finalizeGroupAgentUserVisibleOutput({
          boundedTranscript: outputBuffer.transcriptSnapshot(),
          outputSentToUser,
          undeliveredGenerations: undeliveredGenerations.join('\n\n'),
          sawRawOutput,
          groupName: group.name,
          warn: (metadata, message) => logger.warn(metadata, message),
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
    }
    if (!outputBuffer.intentionalNoReplyRequested()) {
      await sendGroupFinalProgress({
        output,
        hadError,
        sawDeliveryIncomplete,
        sawTerminalDeliveryFailure,
        outputSentToUser,
        options,
        awaitingResponseReceipt,
        sentAnyTurnDoneProgress,
        activeGenerationHasOutput,
        sentTurnDoneProgressGeneration,
        progressGeneration,
        supportsProgress,
        buildProgressOptions,
        sendProgress: sendProgressToChannel,
        sendDone: sendTrackedDoneProgress,
      });
    }
    await setTypingState(false);
    sendProgressToChannel.retire();
    if (resultOk && replay.hasMore) deps.queue.enqueueMessageCheck(queueJid);
    options?.onRunResult?.(output);
    return resultOk;
  }
  return { processGroupMessages };
}
