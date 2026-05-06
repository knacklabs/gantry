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
import {
  decisionForMode,
  normalizePermissionAction,
} from '../permission-interaction.js';

import { TelegramChannelPrompts } from './channel-prompts.js';
import {
  TELEGRAM_PERMISSION_CALLBACK_PATTERN,
  TELEGRAM_USER_QUESTION_CALLBACK_PATTERN,
  TelegramContext,
  escapeTelegramMarkdownV2Literal,
} from './channel-shared.js';

const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

export abstract class TelegramChannelConnect extends TelegramChannelPrompts {
  async connect(): Promise<void> {
    this.isStopping = false;
    this.clearPollingRetryTimer();
    this.bot = new Bot<TelegramContext>(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });
    this.bot.api.config.use(autoRetry());
    this.bot.use(stream());
    this.draftStreamApi = streamApi(this.bot.api.raw);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${escapeTelegramMarkdownV2Literal(String(chatId))}\`\nName: ${escapeTelegramMarkdownV2Literal(chatName)}\nType: ${escapeTelegramMarkdownV2Literal(chatType)}`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('callback_query:data', async (ctx: any) => {
      const data =
        typeof ctx.callbackQuery?.data === 'string'
          ? ctx.callbackQuery.data
          : '';
      const userQuestionMatch =
        TELEGRAM_USER_QUESTION_CALLBACK_PATTERN.exec(data);
      if (userQuestionMatch) {
        const action = userQuestionMatch[1] as 'select' | 'done';
        const requestId = userQuestionMatch[2];
        const questionIndex = Number.parseInt(userQuestionMatch[3], 10);
        const optionIndex = userQuestionMatch[4]
          ? Number.parseInt(userQuestionMatch[4], 10)
          : undefined;
        const key = this.pendingUserQuestionKey(requestId, questionIndex);
        const pending = this.pendingUserQuestions.get(key);
        if (!pending) {
          await ctx.answerCallbackQuery({
            text: 'Question is no longer active.',
            show_alert: true,
          });
          return;
        }
        const callbackChatId = ctx.chat?.id?.toString() || '';
        if (!callbackChatId || callbackChatId !== pending.chatId) {
          await ctx.answerCallbackQuery({
            text: 'This question belongs to a different chat.',
            show_alert: true,
          });
          return;
        }
        const userId = ctx.from?.id?.toString() || '';
        if (!userId) {
          await ctx.answerCallbackQuery({
            text: 'Unable to verify responder identity.',
            show_alert: true,
          });
          return;
        }
        const authorized = await this.isTelegramApproverAuthorized(
          pending.chatId,
          userId,
          pending.sourceGroup,
        );
        if (!authorized) {
          await ctx.answerCallbackQuery({
            text: 'Only the agent DM admin or this conversation control approver can answer.',
            show_alert: true,
          });
          return;
        }
        const answeredBy =
          ctx.from?.first_name || ctx.from?.username || userId || 'unknown';
        if (action === 'done') {
          if (!pending.multiSelect) {
            await ctx.answerCallbackQuery({
              text: 'This question expects a single selection.',
              show_alert: true,
            });
            return;
          }
          const selectedLabels = [...pending.selectedOptionIndexes]
            .sort((a, b) => a - b)
            .map((index) => pending.optionLabels[index])
            .filter(Boolean);
          await this.finalizeUserQuestionPrompt(
            pending,
            selectedLabels,
            answeredBy,
            'answered via Telegram',
          );
          await ctx.answerCallbackQuery({
            text: 'Saved.',
          });
          return;
        }

        if (
          optionIndex === undefined ||
          !Number.isInteger(optionIndex) ||
          optionIndex < 0 ||
          optionIndex >= pending.optionLabels.length
        ) {
          await ctx.answerCallbackQuery({
            text: 'Invalid option.',
            show_alert: true,
          });
          return;
        }

        if (pending.multiSelect) {
          if (pending.selectedOptionIndexes.has(optionIndex)) {
            pending.selectedOptionIndexes.delete(optionIndex);
          } else {
            pending.selectedOptionIndexes.add(optionIndex);
          }
          await this.refreshUserQuestionPrompt(pending);
          await ctx.answerCallbackQuery({
            text: 'Selection updated.',
          });
          return;
        }

        const selected = pending.optionLabels[optionIndex];
        await this.finalizeUserQuestionPrompt(
          pending,
          selected,
          answeredBy,
          'answered via Telegram',
        );
        await ctx.answerCallbackQuery({
          text: 'Saved.',
        });
        return;
      }

      const permissionMatch = TELEGRAM_PERMISSION_CALLBACK_PATTERN.exec(data);
      if (!permissionMatch) return;
      const mode = normalizePermissionAction(permissionMatch[1]);
      if (!mode) return;
      const callbackId = permissionMatch[2];
      const requestId =
        this.pendingPermissionCallbackIds.get(callbackId) || callbackId;
      const pending = this.pendingPermissionPrompts.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery({
          text: 'Permission request is no longer active.',
          show_alert: true,
        });
        return;
      }

      const callbackQuery = ctx.callbackQuery as
        | {
            from?: {
              id?: number | string;
              first_name?: string;
              username?: string;
            };
            message?: { chat?: { id?: number | string } };
          }
        | undefined;
      const callbackChatId =
        callbackQuery?.message?.chat?.id?.toString() ||
        ctx.chat?.id?.toString() ||
        '';
      if (!callbackChatId || callbackChatId !== pending.chatId) {
        await ctx.answerCallbackQuery({
          text: 'This approval request belongs to a different chat.',
          show_alert: true,
        });
        return;
      }

      const userId =
        callbackQuery?.from?.id?.toString() || ctx.from?.id?.toString() || '';
      if (!userId) {
        await ctx.answerCallbackQuery({
          text: 'Unable to verify approver identity.',
          show_alert: true,
        });
        return;
      }
      const authorized = await this.isTelegramApproverAuthorized(
        (pending.approvalContextJid || `tg:${pending.chatId}`).replace(
          /^tg:/,
          '',
        ),
        userId,
        pending.sourceGroup,
        pending.decisionPolicy,
      );
      if (!authorized) {
        logger.warn(
          {
            requestId,
            userId,
            chatId:
              callbackQuery?.message?.chat?.id?.toString() ||
              ctx.chat?.id?.toString() ||
              pending.chatId,
            pendingChatId: pending.chatId,
            approvalContextJid: pending.approvalContextJid,
            sourceGroup: pending.sourceGroup,
            decisionPolicy: pending.decisionPolicy,
          },
          'Telegram permission decision rejected: user is not an approved administrator',
        );
        await ctx.answerCallbackQuery({
          text: 'Only the agent DM admin or this conversation control approver can approve.',
          show_alert: true,
        });
        return;
      }

      const decidedBy =
        callbackQuery?.from?.first_name ||
        callbackQuery?.from?.username ||
        ctx.from?.first_name ||
        ctx.from?.username ||
        userId ||
        'unknown';
      const decision = decisionForMode(pending.request, mode, decidedBy);
      await this.resolvePermissionPrompt(requestId, {
        ...decision,
        reason:
          mode === 'allow_once'
            ? 'allowed once via Telegram'
            : mode === 'allow_persistent_rule'
              ? 'persistent rule allowed via Telegram'
              : 'canceled via Telegram',
      });
      await ctx.answerCallbackQuery({
        text:
          mode === 'allow_once'
            ? 'Allowed once.'
            : mode === 'allow_persistent_rule'
              ? 'Always allowed.'
              : 'Canceled.',
      });
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (for example, ^@Main Agent\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      await this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const group = this.opts.registeredGroups()[chatJid];
      if (!group && isGroup) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      await this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        provider: 'telegram',
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        external_message_id: msgId,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = async (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      await this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const routeGroups = this.opts.registeredGroups;
      let groups = routeGroups();
      if (!isGroup && !groups[chatJid]) {
        await this.opts.ensureMessageRoute?.(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          provider: 'telegram',
          sender: ctx.from?.id?.toString() || '',
          sender_name:
            ctx.from?.first_name ||
            ctx.from?.username ||
            ctx.from?.id?.toString() ||
            'Unknown',
          content: placeholder,
          timestamp,
          is_from_me: false,
          external_message_id: ctx.message.message_id.toString(),
          thread_id: ctx.message.message_thread_id
            ? ctx.message.message_thread_id.toString()
            : undefined,
        });
        groups = routeGroups();
      }

      const group = groups[chatJid];
      if (!group && isGroup) return;

      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const deliver = async (
        content: string,
        attachment?: {
          kind: 'image' | 'file' | 'audio' | 'video' | 'other';
          externalId?: string;
          storageRef?: string;
        },
      ) => {
        const threadId = ctx.message.message_thread_id;
        const msgId = ctx.message.message_id.toString();
        await this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          provider: 'telegram',
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          external_message_id: msgId,
          thread_id: threadId ? threadId.toString() : undefined,
          attachments: attachment
            ? [
                {
                  id: `telegram-attachment:${chatJid}:${msgId}`,
                  kind: attachment.kind,
                  externalId: attachment.externalId,
                  storageRef: attachment.storageRef,
                },
              ]
            : undefined,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId && group) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
        const filePath = await this.downloadFile(
          opts.fileId,
          group.folder,
          filename,
        );
        const kind =
          placeholder === '[Photo]'
            ? 'image'
            : placeholder === '[Video]'
              ? 'video'
              : placeholder === '[Voice message]' || placeholder === '[Audio]'
                ? 'audio'
                : 'file';
        if (filePath) {
          await deliver(`${placeholder} (${filePath})${caption}`, {
            kind,
            externalId: opts.fileId,
            storageRef: filePath,
          });
        } else {
          await deliver(`${placeholder}${caption}`, {
            kind,
            externalId: opts.fileId,
          });
        }
        return;
      }

      await deliver(`${placeholder}${caption}`);
    };

    const enqueueMediaStore = async (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ): Promise<void> => {
      const task = async () => {
        try {
          await storeMedia(ctx, placeholder, opts);
        } catch (err) {
          logger.error(
            { err: this.sanitizeErrorMessage(err) },
            'Telegram media ingestion failed',
          );
        }
      };
      const admitted = this.mediaIngestionQueue.enqueue(task);
      if (admitted) return;

      logger.warn(
        {
          chatId: ctx.chat?.id?.toString(),
          messageId: ctx.message?.message_id?.toString(),
        },
        'Telegram media ingestion queue full; waiting to enqueue media event',
      );
      const queued = await this.mediaIngestionQueue.enqueueWhenAvailable(task);
      if (!queued) {
        logger.error(
          {
            chatId: ctx.chat?.id?.toString(),
            messageId: ctx.message?.message_id?.toString(),
            queueSize: this.mediaIngestionQueue.size(),
          },
          'Telegram media ingestion backlog full; media event was not admitted',
        );
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      await enqueueMediaStore(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', async (ctx) => {
      await enqueueMediaStore(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', async (ctx) => {
      await enqueueMediaStore(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', async (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      await enqueueMediaStore(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      await enqueueMediaStore(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', async (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      await enqueueMediaStore(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', async (ctx) => {
      await enqueueMediaStore(ctx, '[Location]');
    });
    this.bot.on('message:contact', async (ctx) => {
      await enqueueMediaStore(ctx, '[Contact]');
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error(
        { error: this.sanitizeErrorMessage(err) },
        'Telegram bot error',
      );
    });

    this.startPolling();
  }
}
