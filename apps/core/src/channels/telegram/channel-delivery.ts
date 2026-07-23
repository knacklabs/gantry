import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  RichInteractionRequest,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { TelegramChannelConnect } from './channel-connect.js';
import {
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
  TELEGRAM_USER_QUESTION_TIMEOUT_MS,
  ActiveDraftStreamState,
  createPendingTelegramUserQuestion,
  editTelegramMessage,
  escapeTelegramMarkdownV2,
  sendTelegramMessageWithResult,
  splitTelegramDeliveryText,
  telegramThreadOptionsFromString,
  telegramQuestionCallbackId,
} from './channel-shared.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
import {
  clearProgressActions,
  prepareTelegramProgressHandle,
  progressActionOptions,
  sendNewProgressMessage,
} from './progress-message-actions.js';
import { sendTelegramPlannedChunk } from './send-planned-chunk.js';
import { appendTelegramDocumentMessageIds as appendDocIds } from './file-delivery.js';
import { renderTelegramChannelAgentTodo } from './agent-todo-delivery.js';
import { unescapeTelegramEscapedMarkdownV2 } from './markdown-v2-unescape.js';
import { sendTelegramTyping } from './typing-indicator.js';
import { renderTelegramRichInteraction } from './rich-interaction.js';
import { addTelegramReaction } from './reactions.js';
import { disconnectTelegramDelivery } from './disconnect.js';
import { requestTelegramPermissionApproval } from './permission-approval-delivery.js';
import {
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
} from '../../application/interactions/pending-interaction-durability.js';

export abstract class TelegramChannelDelivery extends TelegramChannelConnect {
  private readonly reactionKeys = new Set<string>();

  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<MessageDeliveryResult> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      throw new Error('Telegram bot not initialized');
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const sendOptions = telegramThreadOptionsFromString(options.threadId);

      // Split after escaping so each outbound envelope already matches the
      // exact payload Telegram receives.
      const escapedText = escapeTelegramMarkdownV2(text, {
        preserveStyleMarkers: true,
      });
      const escapedChunks = splitTelegramDeliveryText(
        escapedText,
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
        TELEGRAM_MESSAGE_MAX_LENGTH,
      );
      const chunks = escapedChunks.map((escapedChunk) => ({
        escapedText: escapedChunk,
        canonicalText: unescapeTelegramEscapedMarkdownV2(escapedChunk),
      }));
      if (chunks.length === 0) return {};

      const warnings: string[] = [];
      if (chunks.length > 1) {
        warnings.push(
          `telegram.message.chunked:${chunks.length}:${TELEGRAM_STREAM_CHUNK_MAX_LENGTH}`,
        );
      }

      const externalMessageIds: string[] = [];
      let deliveredChunks = 0;
      let usePlainText = false;
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const replyMarkup =
          chunkIndex === chunks.length - 1
            ? telegramActionReplyMarkup(options.actionAffordances)
            : undefined;
        try {
          const sent = await sendTelegramPlannedChunk(
            this.bot.api,
            numericId,
            chunk.escapedText,
            {
              sendOptions: replyMarkup
                ? { ...sendOptions, reply_markup: replyMarkup }
                : sendOptions,
              plainText: chunk.canonicalText,
              allowPlainTextFallback: !usePlainText,
              forcePlainText: usePlainText,
            },
          );
          usePlainText = sent.usedPlainText || usePlainText;
          const messageId = sent.messageId;
          if (messageId !== undefined) {
            externalMessageIds.push(String(messageId));
          }
          deliveredChunks += 1;
        } catch (err) {
          if (deliveredChunks > 0) {
            const unsentCanonicalTail = chunks
              .slice(deliveredChunks)
              .map((planned) => planned.canonicalText)
              .join('');
            const partial = new PartialMessageDeliveryError({
              cause: err,
              deliveredChunks,
              name: 'PartialTelegramDeliveryError',
              message: `Telegram message partially delivered (${deliveredChunks}/${chunks.length} chunks)`,
              totalChunks: chunks.length,
            });
            Object.assign(partial, {
              provider: 'telegram',
              deliveredParts: deliveredChunks,
              totalParts: chunks.length,
              externalMessageIds,
              ...(unsentCanonicalTail.trim()
                ? {
                    retryTail: {
                      canonicalText: unsentCanonicalTail,
                      providerPayload: {
                        provider: 'telegram',
                        chatId: numericId,
                        ...(options.threadId
                          ? { threadId: options.threadId }
                          : {}),
                      },
                    },
                  }
                : {}),
              ...(warnings.length > 0 ? { warnings } : {}),
            });
            throw partial;
          }
          throw err;
        }
      }
      await appendDocIds(externalMessageIds, this.bot.api, numericId, options);
      logger.info(
        { jid, length: text.length, threadId: options.threadId },
        'Telegram message sent',
      );
      return {
        ...(externalMessageIds[0]
          ? { externalMessageId: externalMessageIds[0] }
          : {}),
        ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
        deliveredParts: deliveredChunks,
        totalParts: chunks.length,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (err) {
      logger.error(
        { jid, error: this.sanitizeErrorMessage(err) },
        'Failed to send Telegram message',
      );
      throw err;
    }
  }

  async renderRichInteraction(
    jid: string,
    render: RichInteractionRequest,
  ): Promise<boolean> {
    if (!this.bot) return false;
    return renderTelegramRichInteraction({
      bot: this.bot,
      jid,
      render,
      sendFallback: (text, options) => this.sendMessage(jid, text, options),
    });
  }

  async addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    await addTelegramReaction({
      bot: this.bot,
      jid,
      messageRef,
      emoji,
      reactionKeys: this.reactionKeys,
    });
  }

  async sendStreamingChunk(
    jid: string,
    text: string,
    options: StreamingChunkOptions = {},
  ): Promise<boolean> {
    if (!this.bot) return false;
    if (!this.shouldAcceptStreamingChunk(jid, options.generation)) return false;

    const numericId = jid.replace(/^tg:/, '');
    const parsedChatId = Number.parseInt(numericId, 10);
    if (!Number.isFinite(parsedChatId)) {
      logger.warn({ jid }, 'Invalid Telegram chat id for streaming chunk');
      return false;
    }
    if (!this.isLikelyPrivateChatId(numericId)) {
      return this.handleGroupStreamingChunk(jid, numericId, text, options);
    }
    if (!this.draftStreamApi) return false;

    const parsedThreadId = options.threadId
      ? Number.parseInt(options.threadId, 10)
      : undefined;
    const key = this.buildDraftStreamKey(jid, options.threadId);
    let state = this.activeDraftStreams.get(key);
    if (!state && !text && options.done) {
      this.markStreamingGenerationDone(jid, options.generation);
      return false;
    }
    const guard = this.streamResetEpochs.guard(key, this.activeDraftStreams);
    if (!state) {
      const draftThreadId = Number.isFinite(parsedThreadId)
        ? parsedThreadId
        : undefined;
      const draftOptions = draftThreadId
        ? {
            message_thread_id: draftThreadId,
            parse_mode: 'MarkdownV2' as const,
          }
        : { parse_mode: 'MarkdownV2' as const };
      const queue = this.createDraftChunkStream();
      const draftIdOffset = this.nextDraftIdOffset * 256;
      this.nextDraftIdOffset += 1;
      const streamState: ActiveDraftStreamState = {
        chatId: parsedChatId,
        threadId: draftThreadId,
        generation: options.generation,
        rawBuffer: '',
        pushChunk: queue.push,
        closeStream: queue.close,
        streamPromise: Promise.resolve(),
      };
      streamState.streamPromise = this.draftStreamApi
        .streamMessage(
          parsedChatId,
          draftIdOffset,
          queue.iterator,
          draftOptions,
          draftOptions,
        )
        .then(() => undefined)
        .catch(async (err) => {
          logger.warn(
            { jid, err: this.sanitizeErrorMessage(err) },
            'Telegram stream send failed; falling back to final message send',
          );
          const fallbackText = streamState.rawBuffer.trim();
          if (
            fallbackText &&
            guard(streamState) &&
            this.isCurrentStreamingGeneration(jid, streamState.generation)
          ) {
            await this.sendMessage(jid, fallbackText, {
              threadId: options.threadId,
            });
          }
          if (guard(streamState))
            this.streamResetEpochs.deleteState(key, this.activeDraftStreams);
        })
        .finally(() => {
          if (guard(streamState)) this.activeDraftStreams.delete(key);
        });
      this.activeDraftStreams.set(key, streamState);
      state = streamState;
    }
    let delivered = false;

    if (text) {
      state.rawBuffer += text;
      const escaped = escapeTelegramMarkdownV2(text);
      for (const chunk of splitTelegramDeliveryText(
        escaped,
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      )) {
        if (chunk.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
          logger.warn(
            { jid, length: chunk.length },
            'Skipping oversize Telegram stream chunk',
          );
          continue;
        }
        state.pushChunk(chunk);
        delivered = true;
      }
    }

    if (options.done) {
      state.closeStream();
      await state.streamPromise;
      if (!guard(state, true)) {
        return delivered || this.activeDraftStreams.has(key);
      }
      this.markStreamingGenerationDone(jid, options.generation);
      this.streamResetEpochs.prune(key);
      delivered = delivered || state.rawBuffer.trim().length > 0;
    }
    return delivered || Boolean(this.activeDraftStreams.get(key));
  }

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<void> {
    if (!this.bot) {
      logger.info(
        { jid, progressText: text, options },
        'Progress lifecycle telegram skipped without bot',
      );
      return;
    }
    const numericId = jid.replace(/^tg:/, '');
    const parsedThreadId = options.threadId
      ? Number.parseInt(options.threadId, 10)
      : undefined;
    const key = `progress:${this.buildDraftStreamKey(jid, options.threadId)}`;
    this.loadPersistedProgressMessages();
    const hasActionMarkup = options.actionAffordances
      ? Boolean(telegramActionReplyMarkup(options.actionAffordances))
      : false;
    const actionOnly = Boolean(options.actionOnly && hasActionMarkup);
    const nextText = actionOnly ? String.fromCharCode(8288) : text.trim();
    if (options.done) {
      this.markProgressGenerationDone(key, options.generation);
    } else if (
      !this.shouldAcceptProgressUpdate(key, options.generation, options.done)
    ) {
      return;
    }
    const prepared = prepareTelegramProgressHandle({
      activeProgressMessages: this.activeProgressMessages,
      persistProgressMessages: () => this.persistProgressMessages(),
      jid,
      key,
      existing: this.activeProgressMessages.get(key),
      chatId: numericId,
      threadId: Number.isFinite(parsedThreadId) ? parsedThreadId : undefined,
      options,
    });
    if (!prepared.accepted) return;
    const existing = prepared.existing;
    if (options.done && nextText === 'Done.') {
      if (existing?.messageId) {
        await clearProgressActions({
          api: this.bot.api,
          chatId: numericId,
          messageId: existing.messageId,
          text: existing.lastText,
          editReplyMarkup: { reply_markup: { inline_keyboard: [] } },
        }).catch(() => undefined);
      }
      this.activeProgressMessages.delete(key);
      this.persistProgressMessages();
      return;
    }
    if (!nextText) {
      if (options.done) {
        this.activeProgressMessages.delete(key);
        this.persistProgressMessages();
        logger.info(
          { jid, key, generation: options.generation },
          'Progress lifecycle telegram cleared empty done',
        );
      }
      return;
    }
    const actionOptions = progressActionOptions(options);
    const sendOptions = {
      ...(Number.isFinite(parsedThreadId)
        ? { message_thread_id: parsedThreadId }
        : {}),
      ...actionOptions.sendOptions,
    };
    if (!existing && options.replaceOnly) {
      logger.info(
        { jid, key, progressText: nextText, generation: options.generation },
        'Progress lifecycle telegram dropped replaceOnly without handle',
      );
      return;
    }
    if (!existing) {
      await sendNewProgressMessage({
        api: this.bot.api,
        activeProgressMessages: this.activeProgressMessages,
        persistProgressMessages: () => this.persistProgressMessages(),
        chatId: numericId,
        key,
        jid,
        text: nextText,
        options,
        sendOptions,
        threadId: Number.isFinite(parsedThreadId) ? parsedThreadId : undefined,
      });
      return;
    }
    if (existing.lastText === nextText) {
      if (options.done) {
        await clearProgressActions({
          api: this.bot.api,
          chatId: numericId,
          messageId: existing.messageId,
          text: nextText,
          editReplyMarkup: actionOptions.editReplyMarkup,
        });
        this.activeProgressMessages.delete(key);
        this.persistProgressMessages();
        logger.info(
          { jid, key, generation: options.generation },
          'Progress lifecycle telegram cleared unchanged done',
        );
      } else if (!options.replaceOnly) {
        existing.messageId = await sendTelegramMessageWithResult(
          this.bot.api,
          numericId,
          nextText,
          sendOptions,
        );
        if (options.generation !== undefined)
          existing.generation = options.generation;
        this.activeProgressMessages.set(key, existing);
        this.persistProgressMessages();
        logger.info(
          {
            jid,
            key,
            generation: options.generation,
            messageId: existing.messageId,
          },
          'Progress lifecycle telegram refreshed unchanged initial message',
        );
      } else {
        if (options.generation !== undefined) {
          existing.generation = options.generation;
          this.activeProgressMessages.set(key, existing);
          this.persistProgressMessages();
        }
        logger.info(
          { jid, key, generation: options.generation },
          'Progress lifecycle telegram skipped unchanged text',
        );
      }
      return;
    }

    if (existing.messageId) {
      try {
        await editTelegramMessage(
          this.bot.api,
          numericId,
          existing.messageId,
          nextText,
          {},
          actionOptions.editReplyMarkup,
        );
      } catch (err) {
        logger.debug(
          { jid, err },
          'Failed to edit progress message, creating a fresh one',
        );
        existing.messageId = await sendTelegramMessageWithResult(
          this.bot.api,
          numericId,
          nextText,
          sendOptions,
        );
        logger.info(
          {
            jid,
            key,
            progressText: nextText,
            generation: options.generation,
            messageId: existing.messageId,
          },
          'Progress lifecycle telegram fallback sent new message',
        );
      }
    } else {
      existing.messageId = await sendTelegramMessageWithResult(
        this.bot.api,
        numericId,
        nextText,
        sendOptions,
      );
      logger.info(
        {
          jid,
          key,
          progressText: nextText,
          generation: options.generation,
          messageId: existing.messageId,
        },
        'Progress lifecycle telegram sent missing-handle message',
      );
    }
    existing.lastText = nextText;
    if (options.generation !== undefined)
      existing.generation = options.generation;
    if (options.done) {
      this.activeProgressMessages.delete(key);
    } else {
      this.activeProgressMessages.set(key, existing);
    }
    this.persistProgressMessages();
    logger.info(
      {
        jid,
        key,
        progressText: nextText,
        done: options.done ?? false,
        generation: options.generation,
        messageId: existing.messageId,
      },
      'Progress lifecycle telegram edited existing message',
    );
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalDecision> {
    return requestTelegramPermissionApproval({
      interactionCallbacksEnabled: this.interactionCallbacksEnabled,
      botConnected: this.bot !== null,
      jid,
      request,
      pendingPrompts: this.pendingPermissionPrompts,
      sendPrompt: (input) => this.sendPermissionPromptMessage(input),
      settlePrompt: (providerAlias, mode, approverRef, reason) =>
        this.claimAndResolvePermissionPrompt(
          providerAlias,
          mode,
          approverRef,
          reason,
        ),
      onPromptDelivered,
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
    });
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void,
  ): Promise<UserQuestionResponse> {
    if (!this.interactionCallbacksEnabled) {
      return {
        requestId: request.requestId,
        answers: {},
        answeredBy: 'system',
      };
    }
    if (!this.bot) {
      return { requestId: request.requestId, answers: {} };
    }
    const chatId = jid.replace(/^tg:/, '');
    if (!chatId) {
      return { requestId: request.requestId, answers: {} };
    }

    const timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS;
    const answers: Record<string, string | string[]> = {};
    let answeredBy: string | undefined;

    for (let i = 0; i < request.questions.length; i += 1) {
      const question = request.questions[i];
      const pendingKey = this.pendingUserQuestionKey(
        request.appId || 'default',
        request.sourceAgentFolder,
        request.requestId,
        i,
      );
      if (this.pendingUserQuestions.has(pendingKey)) {
        logger.warn(
          { requestId: request.requestId, questionIndex: i },
          'Duplicate pending user question request detected',
        );
        continue;
      }

      try {
        const callbackId = telegramQuestionCallbackId();
        const sent = await this.sendUserQuestionPromptMessage({
          chatId,
          requestId: request.requestId,
          questionIndex: i,
          callbackId,
          question,
          threadOpts: telegramThreadOptionsFromString(request.threadId),
        });

        const selectionPromise = createPendingTelegramUserQuestion({
          callbackId,
          pendingKey,
          request,
          question,
          questionIndex: i,
          chatId,
          messageId: sent.messageId,
          promptText: sent.promptText,
          promptIsHtml: sent.promptIsHtml,
          timeoutMs,
          pendingQuestions: this.pendingUserQuestions,
          callbacks: this.pendingUserQuestionCallbackIds,
          finalize: (pending, selection, selectedBy, outcome) =>
            this.finalizeUserQuestionPrompt(
              pending,
              selection,
              selectedBy,
              outcome,
            ),
        });
        onPromptDelivered?.(String(sent.messageId), i);
        const selection = await selectionPromise;

        const isEmptySelection = Array.isArray(selection.selected)
          ? selection.selected.length === 0
          : selection.selected.trim().length === 0;
        if (isEmptySelection) {
          const progressRecorded = await recordDurableQuestionAnswerProgress({
            requestId: request.requestId,
            appId: request.appId,
            sourceAgentFolder: request.sourceAgentFolder,
            answers: { [question.question]: selection.selected },
            completedQuestionIndexes: [i],
          });
          if (!progressRecorded) {
            throw new DurableInteractionPersistenceError(
              'Telegram user question progress was not persisted',
            );
          }
          continue;
        }

        if (selection.answeredBy) answeredBy = selection.answeredBy;
        answers[question.question] = selection.selected;
        const progressRecorded = await recordDurableQuestionAnswerProgress({
          requestId: request.requestId,
          appId: request.appId,
          sourceAgentFolder: request.sourceAgentFolder,
          answers: { [question.question]: selection.selected },
        });
        if (!progressRecorded) {
          throw new DurableInteractionPersistenceError(
            'Telegram user question progress was not persisted',
          );
        }
      } catch (err) {
        if (err instanceof DurableInteractionPersistenceError) throw err;
        logger.warn(
          {
            requestId: request.requestId,
            questionIndex: i,
            err: this.sanitizeErrorMessage(err),
          },
          'Failed to run Telegram user question prompt',
        );
      }
    }

    return {
      requestId: request.requestId,
      answers,
      ...(answeredBy ? { answeredBy } : {}),
    };
  }

  async renderAgentTodo(jid: string, render: AgentTodoRender) {
    if (!this.bot) return false;
    return renderTelegramChannelAgentTodo({
      api: this.bot.api,
      jid,
      render,
      buildDraftStreamKey: (key, threadId) =>
        this.buildDraftStreamKey(key, threadId),
      pendingTodos: this.pendingTodos,
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
    });
  }

  isConnected(): boolean {
    return this.bot !== null;
  }
  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }
  async disconnect(): Promise<void> {
    this.isStopping = true;
    this.clearPollingRetryTimer();
    this.streamResetEpochs.clear();
    const disconnected = await disconnectTelegramDelivery({
      bot: this.bot,
      activeDraftStreams: this.activeDraftStreams,
      activeGroupStreams: this.activeGroupStreams,
      streamGenerationByJid: this.streamGenerationByJid,
      sealedStreamGenerationByJid: this.sealedStreamGenerationByJid,
      activeProgressMessages: this.activeProgressMessages,
      mediaIngestionQueue: this.mediaIngestionQueue,
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      settlePermissionPrompt: (providerAlias) =>
        this.claimAndResolvePermissionPrompt(
          providerAlias,
          'cancel',
          'system',
          'Telegram channel disconnected',
        ),
      pendingUserQuestions: this.pendingUserQuestions,
      pendingUserQuestionCallbackIds: this.pendingUserQuestionCallbackIds,
      releasePollingLease: () => this.releasePollingLease(),
    });
    this.bot = disconnected.bot;
    this.draftStreamApi = disconnected.draftStreamApi;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    await sendTelegramTyping({ bot: this.bot, jid, isTyping });
  }
}
