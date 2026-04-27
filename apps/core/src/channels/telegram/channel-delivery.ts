import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { StreamFlavor, stream, streamApi } from '@grammyjs/stream';

import {
  ASSISTANT_NAME,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  TRIGGER_PATTERN,
} from '../../config/index.js';
import { resolveGroupFolderPath } from '../../platform/group-folder.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelAdapter, ChannelOpts } from '../channel-provider.js';
import {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../runtime/partial-delivery.js';
import { parseTextStyles } from '../../text-styles.js';
import { AsyncTaskQueue } from '../../app/bootstrap/async-task-queue.js';
import { writeTelegramFetchResponseToFile } from '../telegram-file-download.js';

import { TelegramChannelConnect } from './channel-connect.js';
import {
  TELEGRAM_DRAFT_MAX_LENGTH,
  TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
  TELEGRAM_USER_QUESTION_TIMEOUT_MS,
  ActiveDraftStreamState,
  countTelegramTextChunks,
  editTelegramMessage,
  escapeTelegramMarkdownV2,
  iterTelegramTextChunks,
  sendTelegramMessageWithResult,
  telegramThreadOptionsFromString,
} from './channel-shared.js';

export abstract class TelegramChannelDelivery extends TelegramChannelConnect {
  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<{ externalMessageId?: string }> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      throw new Error('Telegram bot not initialized');
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const sendOptions = telegramThreadOptionsFromString(options.threadId);

      // Telegram has a 4096 character limit per message. Split on code-point
      // boundaries so emoji/surrogate pairs are not corrupted between chunks.
      let deliveredChunks = 0;
      let firstMessageId: number | undefined;
      for (const chunk of iterTelegramTextChunks(
        text,
        TELEGRAM_MESSAGE_MAX_LENGTH,
      )) {
        try {
          const messageId = await sendTelegramMessageWithResult(
            this.bot.api,
            numericId,
            chunk,
            sendOptions,
          );
          firstMessageId ??= messageId;
          deliveredChunks += 1;
        } catch (err) {
          if (deliveredChunks > 0) {
            const totalChunks = countTelegramTextChunks(
              text,
              TELEGRAM_MESSAGE_MAX_LENGTH,
            );
            throw new PartialMessageDeliveryError({
              cause: err,
              deliveredChunks,
              name: 'PartialTelegramDeliveryError',
              message: `Telegram message partially delivered (${deliveredChunks}/${totalChunks} chunks)`,
              totalChunks,
            });
          }
          throw err;
        }
      }
      logger.info(
        { jid, length: text.length, threadId: options.threadId },
        'Telegram message sent',
      );
      return firstMessageId !== undefined
        ? { externalMessageId: String(firstMessageId) }
        : {};
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
    if (!this.bot || !this.draftStreamApi) return false;
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
      for (const chunk of iterTelegramTextChunks(
        escaped,
        TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
      )) {
        if (chunk.length > TELEGRAM_DRAFT_MAX_LENGTH) {
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
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    const parsedThreadId = options.threadId
      ? Number.parseInt(options.threadId, 10)
      : undefined;
    const key = `progress:${this.buildDraftStreamKey(jid, options.threadId)}`;
    const nextText = text.trim();
    if (!nextText) {
      if (options.done) this.activeProgressMessages.delete(key);
      return;
    }

    const sendOptions = Number.isFinite(parsedThreadId)
      ? { message_thread_id: parsedThreadId }
      : {};
    const existing = this.activeProgressMessages.get(key);
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
        });
      }
      return;
    }

    if (existing.lastText === nextText) {
      if (options.done) this.activeProgressMessages.delete(key);
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
      }
    } else {
      existing.messageId = await sendTelegramMessageWithResult(
        this.bot.api,
        numericId,
        nextText,
        sendOptions,
      );
    }
    existing.lastText = nextText;
    if (options.done) {
      this.activeProgressMessages.delete(key);
    } else {
      this.activeProgressMessages.set(key, existing);
    }
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

    const timeoutMs = TELEGRAM_USER_QUESTION_TIMEOUT_MS;
    const promptText = this.formatPermissionPromptText(request, timeoutMs);
    try {
      const sent = await this.bot.api.sendMessage(chatId, promptText, {
        ...telegramThreadOptionsFromString(request.threadId),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Approve',
                callback_data: `perm:approve:${request.requestId}`,
              },
              { text: 'Deny', callback_data: `perm:deny:${request.requestId}` },
            ],
          ],
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
          sourceGroup: request.sourceGroup,
          chatId,
          messageId: sent.message_id,
          timer,
          resolve,
        });
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
            sourceGroup: request.sourceGroup,
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
