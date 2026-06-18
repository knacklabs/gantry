import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../../config/index.js';
import {
  findDurablePermissionInteractionByRequestId,
  findDurableQuestionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionInteractionByRequestId,
} from '../../application/interactions/pending-interaction-durability.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  decisionForMode,
  normalizePermissionAction,
  permissionDecisionOptions,
} from '../permission-interaction.js';

import { TelegramChannelPrompts } from './channel-prompts.js';
import {
  TELEGRAM_PERMISSION_CALLBACK_PATTERN,
  TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN,
  TELEGRAM_USER_QUESTION_CALLBACK_PATTERN,
  TelegramContext,
} from './channel-shared.js';
import {
  createTelegramBotRuntime,
  registerTelegramBotCommands,
} from './bot-setup.js';
import { registerTelegramMediaHandlers } from './media-ingestion.js';

const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

export abstract class TelegramChannelConnect extends TelegramChannelPrompts {
  async connect(
    options: { inbound?: boolean; interactionCallbacks?: boolean } = {},
  ): Promise<void> {
    this.isStopping = false;
    this.interactionCallbacksEnabled =
      options.interactionCallbacks ?? options.inbound !== false;
    this.clearPollingRetryTimer();
    const runtime = createTelegramBotRuntime(this.botToken);
    this.bot = runtime.bot;
    this.draftStreamApi = runtime.draftStreamApi;
    registerTelegramBotCommands(this.bot, ASSISTANT_NAME);

    this.bot.on('callback_query:data', async (ctx: any) => {
      const data =
        typeof ctx.callbackQuery?.data === 'string'
          ? ctx.callbackQuery.data
          : '';
      const userQuestionMatch =
        TELEGRAM_USER_QUESTION_CALLBACK_PATTERN.exec(data);
      if (userQuestionMatch) {
        const action = userQuestionMatch[1] as 'select' | 'done' | 'other';
        const requestId = userQuestionMatch[2];
        const questionIndex = Number.parseInt(userQuestionMatch[3], 10);
        const optionIndex = userQuestionMatch[4]
          ? Number.parseInt(userQuestionMatch[4], 10)
          : undefined;
        const key = this.pendingUserQuestionKey(requestId, questionIndex);
        const pending = this.pendingUserQuestions.get(key);
        if (!pending) {
          const callbackChatId =
            ctx.callbackQuery?.message?.chat?.id?.toString() ||
            ctx.chat?.id?.toString() ||
            '';
          const userId = ctx.from?.id?.toString() || '';
          const durable = await findDurableQuestionInteractionByRequestId({
            requestId,
          });
          const authorized =
            durable?.targetJid === `tg:${callbackChatId}` &&
            userId &&
            (await this.isTelegramApproverAuthorized(
              callbackChatId,
              userId,
              durable.sourceAgentFolder,
            ));
          const answeredBy =
            ctx.from?.first_name || ctx.from?.username || userId || 'unknown';
          if (authorized && action === 'other') {
            const threadId = (
              ctx.callbackQuery?.message as
                | { message_thread_id?: number }
                | undefined
            )?.message_thread_id;
            let promptMessageId: number | undefined;
            try {
              const prompt = await ctx.api.sendMessage(
                callbackChatId,
                'Reply to this message with your answer.',
                {
                  ...(typeof threadId === 'number'
                    ? { message_thread_id: threadId }
                    : {}),
                  reply_markup: {
                    force_reply: true,
                    input_field_placeholder: 'Type your answer…',
                  },
                },
              );
              promptMessageId = prompt.message_id;
            } catch (err) {
              logger.debug(
                { requestId, err: this.sanitizeErrorMessage(err) },
                'Failed to send Telegram durable Other free-text prompt',
              );
            }
            if (promptMessageId === undefined) {
              await ctx.answerCallbackQuery({
                text: 'Could not start a free-text reply.',
                show_alert: true,
              });
              return;
            }
            this.pendingUserQuestionOtherPrompts.set(
              `${callbackChatId}:${promptMessageId}`,
              { requestId, questionIndex },
            );
            await ctx.answerCallbackQuery({ text: 'Reply with your answer.' });
            return;
          }
          const resolved =
            authorized &&
            (action === 'done' ||
              (optionIndex !== undefined && Number.isInteger(optionIndex)))
              ? await resolveDurableQuestionInteractionByRequestId({
                  requestId,
                  questionIndex,
                  optionIndex,
                  finalize: action === 'done',
                  answeredBy,
                })
              : false;
          await ctx.answerCallbackQuery({
            text: resolved
              ? 'Answer recorded. Details will update in chat.'
              : 'Question is no longer active.',
            show_alert: !resolved,
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
          pending.sourceAgentFolder,
        );
        if (!authorized) {
          await ctx.answerCallbackQuery({
            text: 'Only a conversation control approver can answer.',
            show_alert: true,
          });
          return;
        }
        if (action === 'other') {
          const threadId = (
            ctx.callbackQuery?.message as
              | { message_thread_id?: number }
              | undefined
          )?.message_thread_id;
          let promptMessageId: number | undefined;
          try {
            const prompt = await ctx.api.sendMessage(
              pending.chatId,
              'Reply to this message with your answer.',
              {
                ...(typeof threadId === 'number'
                  ? { message_thread_id: threadId }
                  : {}),
                reply_markup: {
                  force_reply: true,
                  input_field_placeholder: 'Type your answer…',
                },
              },
            );
            promptMessageId = prompt.message_id;
          } catch (err) {
            logger.debug(
              { requestId, err: this.sanitizeErrorMessage(err) },
              'Failed to send Telegram Other free-text prompt',
            );
          }
          if (promptMessageId === undefined) {
            await ctx.answerCallbackQuery({
              text: 'Could not start a free-text reply.',
              show_alert: true,
            });
            return;
          }
          this.pendingUserQuestionOtherPrompts.set(
            `${pending.chatId}:${promptMessageId}`,
            { requestId, questionIndex },
          );
          await ctx.answerCallbackQuery({ text: 'Reply with your answer.' });
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

      const deadLetterActionMatch =
        TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN.exec(data);
      if (deadLetterActionMatch) {
        await ctx.answerCallbackQuery({
          text: 'Open the scheduler surface or use scheduler tools to run this action.',
          show_alert: true,
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
        const callbackQuery = ctx.callbackQuery as
          | {
              from?: {
                id?: number | string;
                first_name?: string;
                username?: string;
              };
            }
          | undefined;
        const decidedBy =
          callbackQuery?.from?.first_name ||
          callbackQuery?.from?.username ||
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'unknown';
        const durable = await findDurablePermissionInteractionByRequestId({
          requestId,
        });
        const callbackChatId =
          ctx.callbackQuery?.message?.chat?.id?.toString() ||
          ctx.chat?.id?.toString() ||
          '';
        const userId =
          callbackQuery?.from?.id?.toString() || ctx.from?.id?.toString() || '';
        const authorized =
          durable?.targetJid === `tg:${callbackChatId}` &&
          userId &&
          (await this.isTelegramApproverAuthorized(
            callbackChatId,
            userId,
            durable.sourceAgentFolder,
            durable.decisionPolicy as never,
          ));
        const resolved = authorized
          ? await resolveDurablePermissionInteractionByRequestId({
              requestId,
              mode,
              approverRef: decidedBy,
              reason: `resolved via Telegram after channel restart`,
            })
          : false;
        await ctx.answerCallbackQuery({
          text: resolved
            ? 'Decision recorded. Details will update in chat.'
            : 'Permission request is no longer active.',
          show_alert: !resolved,
        });
        return;
      }
      if (!permissionDecisionOptions(pending.request).includes(mode)) {
        await ctx.answerCallbackQuery({
          text: 'This approval option is no longer available.',
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
        pending.sourceAgentFolder,
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
            sourceAgentFolder: pending.sourceAgentFolder,
            decisionPolicy: pending.decisionPolicy,
          },
          'Telegram permission decision rejected: user is not an approved administrator',
        );
        await ctx.answerCallbackQuery({
          text: 'Only a conversation control approver can approve.',
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
              : mode === 'allow_timed_grant'
                ? `eligible tools/SDK API prompt grant (5 min) via Telegram`
                : 'canceled via Telegram',
      });
      await ctx.answerCallbackQuery({
        text:
          mode === 'allow_once'
            ? 'Allowed once. Details posted in chat.'
            : mode === 'allow_persistent_rule'
              ? 'Allowed for future. Details posted in chat.'
              : mode === 'allow_timed_grant'
                ? 'Allowed for 5 min. Details posted in chat.'
                : 'Canceled.',
      });
    });

    if (options.inbound === false) {
      logger.info('Telegram outbound delivery client initialized');
      return;
    }

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

      // A reply to an "Other" ForceReply prompt answers a pending question.
      if (typeof replyTo?.message_id === 'number') {
        const handledOther = await this.tryResolveUserQuestionOtherReply({
          chatId: ctx.chat.id.toString(),
          replyToMessageId: replyTo.message_id,
          text: ctx.message.text,
          userId: sender,
          answeredBy: senderName,
        });
        if (handledOther) return;
      }

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (for example, ^@Default Agent\b), so we prepend the trigger when the bot is @mentioned.
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

      const group = this.opts.conversationRoutes()[chatJid];
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

    registerTelegramMediaHandlers({
      bot: this.bot,
      opts: this.opts,
      mediaIngestionQueue: this.mediaIngestionQueue,
      downloadFile: (fileId, folder, filename) =>
        this.downloadFile(fileId, folder, filename),
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
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
