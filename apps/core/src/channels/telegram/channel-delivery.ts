import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';

import { TelegramChannelConnect } from './channel-connect.js';
import {
  TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
  TELEGRAM_USER_QUESTION_TIMEOUT_MS,
  ActiveDraftStreamState,
  editTelegramMessage,
  escapeTelegramMarkdownV2,
  sendTelegramMessageWithResult,
  splitTelegramDeliveryText,
  telegramThreadOptionsFromString,
} from './channel-shared.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
import { sendTelegramPlannedChunk } from './send-planned-chunk.js';
import {
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';

const TELEGRAM_ESCAPED_MARKDOWN_V2_CHAR_PATTERN =
  /\\([_*~[\]()`>#+\-=|{}.!\\])/g;

function unescapeTelegramEscapedMarkdownV2(text: string): string {
  if (!text) return text;
  return text.replace(TELEGRAM_ESCAPED_MARKDOWN_V2_CHAR_PATTERN, '$1');
}

export abstract class TelegramChannelDelivery extends TelegramChannelConnect {
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
      const escapedText = escapeTelegramMarkdownV2(text);
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
      const createdState = streamState;
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
            this.isCurrentStreamingGeneration(jid, streamState.generation)
          ) {
            await this.sendMessage(jid, fallbackText, {
              threadId: options.threadId,
            });
          }
        })
        .finally(() => {
          const current = this.activeDraftStreams.get(key);
          if (current === createdState) {
            this.activeDraftStreams.delete(key);
          }
        });
      this.activeDraftStreams.set(key, streamState);
      state = streamState;
    }
    if (!state) return false;

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
      this.markStreamingGenerationDone(jid, options.generation);
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
    const nextText = text.trim();
    if (options.done) {
      this.markProgressGenerationDone(key, options.generation);
    } else if (
      !this.shouldAcceptProgressUpdate(key, options.generation, options.done)
    ) {
      return;
    }
    let existing = this.activeProgressMessages.get(key);
    if (
      existing &&
      options.generation !== undefined &&
      existing.generation !== undefined &&
      existing.generation !== options.generation &&
      !(options.done && options.generation > existing.generation)
    ) {
      if (options.done || options.replaceOnly) {
        logger.info(
          {
            jid,
            key,
            done: options.done ?? false,
            replaceOnly: options.replaceOnly ?? false,
            generation: options.generation,
            existingGeneration: existing.generation,
          },
          'Progress lifecycle telegram dropped generation mismatch',
        );
        return;
      }
      logger.info(
        {
          jid,
          key,
          done: options.done ?? false,
          generation: options.generation,
          existingGeneration: existing.generation,
        },
        'Progress lifecycle telegram generation rollover',
      );
      this.activeProgressMessages.delete(key);
      this.persistProgressMessages();
      if (!options.done) existing = undefined;
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
    const sendOptions = Number.isFinite(parsedThreadId)
      ? { message_thread_id: parsedThreadId }
      : {};
    if (!existing && options.replaceOnly) {
      logger.info(
        { jid, key, progressText: nextText, generation: options.generation },
        'Progress lifecycle telegram dropped replaceOnly without handle',
      );
      return;
    }
    if (!existing) {
      const messageId = await sendTelegramMessageWithResult(
        this.bot.api,
        numericId,
        nextText,
        sendOptions,
      );
      if (!options.done) {
        this.activeProgressMessages.set(key, {
          chatId: numericId,
          threadId: Number.isFinite(parsedThreadId)
            ? parsedThreadId
            : undefined,
          messageId,
          lastText: nextText,
          ...(options.generation !== undefined
            ? { generation: options.generation }
            : {}),
        });
        this.persistProgressMessages();
      }
      logger.info(
        {
          jid,
          key,
          progressText: nextText,
          done: options.done ?? false,
          generation: options.generation,
          messageId,
          storedHandle: !options.done,
        },
        'Progress lifecycle telegram sent new message',
      );
      return;
    }

    if (existing.lastText === nextText) {
      if (options.done) {
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
        if (options.generation !== undefined) {
          existing.generation = options.generation;
        }
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
  ): Promise<PermissionApprovalDecision> {
    if (!this.bot) {
      return { approved: false, reason: 'Telegram bot is not connected' };
    }
    const chatId = jid.replace(/^tg:/, '');
    if (!chatId) {
      return { approved: false, reason: 'Invalid Telegram chat ID' };
    }
    if (this.pendingPermissionPrompts.has(request.requestId)) {
      return {
        approved: false,
        reason: `Duplicate pending request: ${request.requestId}`,
      };
    }

    const callbackId = this.nextPermissionCallbackId();
    const timeoutMs = TELEGRAM_USER_QUESTION_TIMEOUT_MS;
    const promptText = this.formatPermissionPromptText(request, timeoutMs);
    try {
      const sent = await this.bot.api.sendMessage(chatId, promptText, {
        ...telegramThreadOptionsFromString(request.threadId),
        reply_markup: {
          inline_keyboard: permissionDecisionOptions(request).map((mode) => [
            {
              text: permissionButtonLabel(mode, request),
              callback_data: `perm:${mode}:${callbackId}`,
            },
          ]),
        },
      });
      return await new Promise<PermissionApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          void this.resolvePermissionPrompt(request.requestId, {
            approved: false,
            decidedBy: 'system',
            reason: 'timed out',
          });
        }, timeoutMs);
        this.pendingPermissionPrompts.set(request.requestId, {
          callbackId,
          sourceAgentFolder: request.sourceAgentFolder,
          decisionPolicy: request.decisionPolicy,
          approvalContextJid: request.approvalContextJid,
          request,
          chatId,
          messageId: sent.message_id,
          timer,
          resolve,
        });
        this.pendingPermissionCallbackIds.set(callbackId, request.requestId);
      });
    } catch (err) {
      logger.error(
        {
          jid,
          requestId: request.requestId,
          error: this.sanitizeErrorMessage(err),
        },
        'Failed to send Telegram permission prompt',
      );
      return {
        approved: false,
        reason: 'Failed to send approval prompt to Telegram',
      };
    }
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
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
      const pendingKey = this.pendingUserQuestionKey(request.requestId, i);
      if (this.pendingUserQuestions.has(pendingKey)) {
        logger.warn(
          { requestId: request.requestId, questionIndex: i },
          'Duplicate pending user question request detected',
        );
        continue;
      }

      const promptText = this.formatUserQuestionPromptText(
        request,
        question,
        timeoutMs,
      );
      try {
        const sent = await this.bot.api.sendMessage(chatId, promptText, {
          ...telegramThreadOptionsFromString(request.threadId),
          reply_markup: this.buildUserQuestionKeyboard(
            request.requestId,
            i,
            question,
            new Set<number>(),
          ),
        });

        const selection = await new Promise<{
          selected: string | string[];
          answeredBy?: string;
        }>((resolve) => {
          const timer = setTimeout(() => {
            const timedOut = this.pendingUserQuestions.get(pendingKey);
            if (!timedOut) return;
            // Fire-and-forget is intentional: timer callback should never block
            // the event loop while we cleanup stale pending prompts.
            void this.finalizeUserQuestionPrompt(
              timedOut,
              timedOut.multiSelect ? [] : '',
              'system',
              'timed out',
            );
          }, timeoutMs);

          this.pendingUserQuestions.set(pendingKey, {
            requestId: request.requestId,
            sourceAgentFolder: request.sourceAgentFolder,
            questionIndex: i,
            questionHeader: question.header,
            questionText: question.question,
            promptText,
            optionLabels: question.options.map((option) => option.label),
            multiSelect: question.multiSelect,
            selectedOptionIndexes: new Set<number>(),
            chatId,
            messageId: sent.message_id,
            timer,
            resolve,
          });
        });

        const isEmptySelection = Array.isArray(selection.selected)
          ? selection.selected.length === 0
          : selection.selected.trim().length === 0;
        if (isEmptySelection) {
          // Timeout or explicit empty submission: omit this answer so the SDK
          // receives an empty answer map and treats it as unanswered/declined.
          continue;
        }

        if (selection.answeredBy) answeredBy = selection.answeredBy;
        if (Array.isArray(selection.selected)) {
          answers[question.question] = selection.selected;
        } else {
          answers[question.question] = selection.selected;
        }
      } catch (err) {
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

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  resetStreaming(jid: string): void {
    this.sealStreamingGenerationOnReset(jid);
    this.clearStreamingStateForJid(jid);
  }

  async disconnect(): Promise<void> {
    this.isStopping = true;
    this.clearPollingRetryTimer();
    for (const streamState of this.activeDraftStreams.values()) {
      streamState.closeStream();
    }
    this.activeDraftStreams.clear();
    this.activeGroupStreams.clear();
    this.streamGenerationByJid.clear();
    this.sealedStreamGenerationByJid.clear();
    this.activeProgressMessages.clear();
    const mediaDrained = await this.mediaIngestionQueue.waitForIdle(
      TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS,
    );
    if (!mediaDrained) {
      logger.warn(
        { timeoutMs: TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS },
        'Timed out waiting for Telegram media ingestion queue to drain',
      );
    }
    for (const [
      requestId,
      pending,
    ] of this.pendingPermissionPrompts.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        approved: false,
        decidedBy: 'system',
        reason: 'Telegram channel disconnected',
      });
      this.pendingPermissionPrompts.delete(requestId);
      this.pendingPermissionCallbackIds.delete(pending.callbackId);
    }
    for (const [key, pending] of this.pendingUserQuestions.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        selected: pending.multiSelect ? [] : '',
        answeredBy: 'system',
      });
      this.pendingUserQuestions.delete(key);
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      this.draftStreamApi = null;
      await this.releasePollingLease();
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
