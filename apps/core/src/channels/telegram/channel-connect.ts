import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../../config/index.js';
import { resolveDurableQuestionInteractionByRequestId } from '../../application/interactions/pending-interaction-durability.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  normalizePermissionAction,
  permissionDecisionOptions,
} from '../permission-interaction.js';

import { TelegramChannelPrompts } from './channel-prompts.js';
import { resolveDurableTelegramPermissionCallback } from './permission-callback.js';
import {
  TELEGRAM_PERMISSION_CALLBACK_PATTERN,
  TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN,
  TELEGRAM_USER_QUESTION_CALLBACK_PATTERN,
} from './channel-shared.js';
import {
  createTelegramBotRuntime,
  registerTelegramBotCommands,
} from './bot-setup.js';
import { registerTelegramMediaHandlers } from './media-ingestion.js';
import { clearProgressActions } from './progress-message-actions.js';
import { handleTelegramTextMessage } from './text-message-handler.js';
import {
  handleTelegramGroupJoinCallback,
  handleTelegramGroupMembershipUpdate,
} from './group-join-onboarding.js';

export abstract class TelegramChannelConnect extends TelegramChannelPrompts {
  private async clearRestoredProgressActions(): Promise<void> {
    this.loadPersistedProgressMessages();
    for (const [key, state] of this.activeProgressMessages.entries()) {
      if (!state.restored || !state.messageId) continue;
      await clearProgressActions({
        api: this.bot!.api,
        chatId: state.chatId,
        messageId: state.messageId,
        text: state.lastText,
        editReplyMarkup: { reply_markup: { inline_keyboard: [] } },
      }).catch((err) =>
        logger.debug(
          { key, err: this.sanitizeErrorMessage(err) },
          'Failed to clear restored Telegram progress actions',
        ),
      );
    }
  }

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
      if (
        await handleTelegramGroupJoinCallback({
          ctx,
          opts: this.opts,
          assistantName: ASSISTANT_NAME,
          isApproverAuthorized: (chatId, userId, sourceAgentFolder) =>
            this.isTelegramApproverAuthorized(
              chatId,
              userId,
              sourceAgentFolder,
            ),
          sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
        })
      ) {
        return;
      }
      const userQuestionMatch =
        TELEGRAM_USER_QUESTION_CALLBACK_PATTERN.exec(data);
      if (userQuestionMatch) {
        const action = userQuestionMatch[1] as 'select' | 'done' | 'other';
        const callbackId = userQuestionMatch[2];
        const callbackTarget =
          this.pendingUserQuestionCallbackIds.get(callbackId);
        if (!callbackTarget) {
          await ctx.answerCallbackQuery({
            text: 'Question is no longer active.',
            show_alert: true,
          });
          return;
        }
        const requestId = callbackTarget.requestId;
        const questionIndex = callbackTarget.questionIndex;
        const optionIndex = userQuestionMatch[3]
          ? Number.parseInt(userQuestionMatch[3], 10)
          : undefined;
        if (!Number.isInteger(questionIndex)) return;
        const key = this.pendingUserQuestionKey(
          callbackTarget.appId,
          callbackTarget.sourceAgentFolder,
          requestId,
          questionIndex,
        );
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
              { message_thread_id?: number } | undefined
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
            {
              appId: pending.appId,
              sourceAgentFolder: pending.sourceAgentFolder,
              requestId,
              questionIndex,
            },
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
          const persisted = await resolveDurableQuestionInteractionByRequestId({
            requestId,
            appId: pending.appId,
            sourceAgentFolder: pending.sourceAgentFolder,
            questionIndex,
            optionIndex,
            finalize: false,
          });
          if (!persisted) {
            await ctx.answerCallbackQuery({
              text: 'Question is no longer active.',
              show_alert: true,
            });
            return;
          }
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

      if (data.startsWith('lt:stop:')) {
        const callbackMessage = ctx.callbackQuery?.message as
          | {
              chat?: { id?: number | string };
              message_thread_id?: number;
            }
          | undefined;
        const chatId =
          callbackMessage?.chat?.id?.toString() ||
          ctx.chat?.id?.toString() ||
          '';
        if (!chatId) return;
        await this.opts.onMessageAction?.({
          kind: 'live_turn_stop',
          conversationJid: `tg:${chatId}`,
          ...(this.opts.providerAccountId
            ? { providerAccountId: this.opts.providerAccountId }
            : {}),
          threadId:
            typeof callbackMessage?.message_thread_id === 'number'
              ? String(callbackMessage.message_thread_id)
              : undefined,
          userId: ctx.from?.id?.toString(),
          actionToken: data.slice('lt:stop:'.length),
        });
        await ctx.answerCallbackQuery({ text: 'Stopping current run.' });
        return;
      }

      const compactRetryJobId = data.startsWith('r:') ? data.slice(2) : '';
      const deadLetterActionMatch = compactRetryJobId
        ? null
        : TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN.exec(data);
      if (compactRetryJobId || deadLetterActionMatch) {
        if (
          compactRetryJobId ||
          (deadLetterActionMatch?.[1] === 'retry' && deadLetterActionMatch[2])
        ) {
          let jobId: string;
          try {
            jobId = decodeURIComponent(
              compactRetryJobId || deadLetterActionMatch![2],
            );
          } catch {
            await ctx.answerCallbackQuery({
              text: 'Invalid scheduler action.',
              show_alert: true,
            });
            return;
          }
          const callbackMessage = ctx.callbackQuery?.message as
            | {
                chat?: { id?: number | string };
                message_thread_id?: number;
              }
            | undefined;
          const chatId =
            callbackMessage?.chat?.id?.toString() ||
            ctx.chat?.id?.toString() ||
            '';
          if (!chatId) return;
          await this.opts.onMessageAction?.({
            kind: 'scheduler_run_now',
            conversationJid: `tg:${chatId}`,
            ...(this.opts.providerAccountId
              ? { providerAccountId: this.opts.providerAccountId }
              : {}),
            threadId:
              typeof callbackMessage?.message_thread_id === 'number'
                ? String(callbackMessage.message_thread_id)
                : undefined,
            userId: ctx.from?.id?.toString(),
            jobId,
          });
          await ctx.answerCallbackQuery({ text: 'Checking retry request.' });
          return;
        }
        await ctx.answerCallbackQuery({
          text: 'Open the scheduler surface or use scheduler tools to run this action.',
          show_alert: true,
        });
        return;
      }

      const permissionMatch = TELEGRAM_PERMISSION_CALLBACK_PATTERN.exec(data);
      if (!permissionMatch) {
        if (data.startsWith('perm:')) {
          await ctx.answerCallbackQuery({
            text: 'Permission request is no longer active.',
            show_alert: true,
          });
        }
        return;
      }
      const mode = normalizePermissionAction(permissionMatch[1]);
      if (!mode) return;
      const callbackId = permissionMatch[2];
      const pending = this.pendingPermissionPrompts.get(callbackId);
      if (!pending) {
        await resolveDurableTelegramPermissionCallback({
          context: ctx,
          appId: this.opts.appId || 'default',
          providerAlias: callbackId,
          mode,
          sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
          isAuthorized: (approvalContextJid, userId, recovered) =>
            this.isTelegramApproverAuthorized(
              approvalContextJid.replace(/^tg:/, ''),
              userId,
              recovered.sourceAgentFolder,
              recovered.decisionPolicy as never,
              recovered.threadId ?? undefined,
            ),
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
        pending.request.threadId,
      );
      if (!authorized) {
        logger.warn(
          {
            requestId: pending.request.requestId,
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

      const settled = await this.claimAndResolvePermissionPrompt(
        callbackId,
        mode,
        userId,
        mode === 'allow_once'
          ? 'allowed once via Telegram'
          : mode === 'allow_persistent_rule'
            ? 'persistent rule allowed via Telegram'
            : 'canceled via Telegram',
      );
      if (settled === 'already_decided') {
        await ctx.answerCallbackQuery({
          text: 'Permission request was already decided.',
          show_alert: true,
        });
        return;
      }
      if (settled === 'retryable') {
        await ctx.answerCallbackQuery({
          text: 'Could not record the decision. Please retry.',
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({
        text:
          mode === 'allow_persistent_rule' && pending.request.permissionBatch
            ? 'Starting individual review.'
            : mode === 'allow_once'
              ? 'Allowed once.'
              : mode === 'allow_persistent_rule'
                ? 'Allowed for future.'
                : 'Canceled.',
      });
    });

    if (options.inbound === false) {
      logger.info('Telegram outbound delivery client initialized');
      return;
    }

    this.bot.on('my_chat_member', (ctx) =>
      handleTelegramGroupMembershipUpdate({
        ctx,
        opts: this.opts,
        assistantName: ASSISTANT_NAME,
        isApproverAuthorized: (chatId, userId, sourceAgentFolder) =>
          this.isTelegramApproverAuthorized(chatId, userId, sourceAgentFolder),
        sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
      }),
    );

    this.bot.on('message:text', (ctx) =>
      handleTelegramTextMessage({
        ctx,
        opts: this.opts,
        assistantName: ASSISTANT_NAME,
        triggerPattern: TRIGGER_PATTERN,
        tryResolveOther: (input) =>
          this.tryResolveUserQuestionOtherReply(input),
      }),
    );

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

    await this.clearRestoredProgressActions();
    this.startPolling();
  }
}
