import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';

import { TelegramChannelPrompts } from './channel-prompts.js';
import {
  createTelegramCallbackContext,
  dispatchTelegramCallback,
  type TelegramCallbackChannel,
} from './callback-handlers.js';
import {
  createTelegramBotRuntime,
  registerTelegramBotCommands,
} from './bot-setup.js';
import { registerTelegramMediaHandlers } from './media-ingestion.js';
import { clearRestoredTelegramProgressActions } from './extracted-helpers.js';
import { handleTelegramTextMessage } from './text-message-handler.js';
import { handleTelegramGroupMembershipUpdate } from './group-join-onboarding.js';

export abstract class TelegramChannelConnect extends TelegramChannelPrompts {
  private async clearRestoredProgressActions(): Promise<void> {
    this.loadPersistedProgressMessages();
    await clearRestoredTelegramProgressActions({
      activeProgressMessages: this.activeProgressMessages,
      api: this.bot!.api,
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
    });
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

    const callbackChannel: TelegramCallbackChannel = {
      opts: this.opts,
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      pendingUserQuestionCallbackIds: this.pendingUserQuestionCallbackIds,
      pendingUserQuestions: this.pendingUserQuestions,
      pendingUserQuestionOtherPrompts: this.pendingUserQuestionOtherPrompts,
      pendingUserQuestionKey: (...args) => this.pendingUserQuestionKey(...args),
      isTelegramApproverAuthorized: (...args) =>
        this.isTelegramApproverAuthorized(...args),
      finalizeUserQuestionPrompt: (...args) =>
        this.finalizeUserQuestionPrompt(...args),
      refreshUserQuestionPrompt: (...args) =>
        this.refreshUserQuestionPrompt(...args),
      claimAndResolvePermissionPrompt: (...args) =>
        this.claimAndResolvePermissionPrompt(...args),
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
    };
    this.bot.on('callback_query:data', async (rawContext: any) => {
      const data =
        typeof rawContext.callbackQuery?.data === 'string'
          ? rawContext.callbackQuery.data
          : '';
      const callbackContext = createTelegramCallbackContext({
        raw: rawContext,
        data,
        providerAccountId: this.opts.providerAccountId,
      });
      await dispatchTelegramCallback(callbackChannel, callbackContext);
    });

    if (options.inbound === false) {
      logger.info('Telegram outbound delivery client initialized');
      return;
    }

    this.bot.on('my_chat_member', (ctx) =>
      handleTelegramGroupMembershipUpdate({
        ctx,
        opts: this.opts,
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
