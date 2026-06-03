import { createHash } from 'crypto';
import path from 'path';

import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ensurePrivateDirSync } from '../../shared/private-fs.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import { writeTelegramFetchResponseToFile } from '../telegram-file-download.js';
import {
  buildPermissionPromptParts,
  formatPermissionPromptText,
  formatPermissionReceiptText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import {
  escapeTelegramHtml,
  renderPermissionPromptHtml,
  renderUserQuestionPromptHtml,
} from './html-render.js';

import { TelegramChannelState } from './channel-state.js';

const TELEGRAM_POLL_LEASE_HASH_CHARS = 24;
import {
  PendingUserQuestionState,
  TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES,
  truncateUtf8ToByteLimit,
} from './channel-shared.js';

export interface TelegramDownloadedFile {
  filePath: string;
  storageRef: string;
}

export abstract class TelegramChannelPrompts extends TelegramChannelState {
  protected pendingUserQuestionKey(
    requestId: string,
    questionIndex: number,
  ): string {
    return `${requestId}:${questionIndex}`;
  }

  protected formatUserQuestionButtonLabel(
    optionLabel: string,
    optionIndex: number,
    multiSelect: boolean,
    isSelected: boolean,
  ): string {
    const ordinal = `${optionIndex + 1}. `;
    const selectedPrefix = multiSelect && isSelected ? '✅ ' : '';
    const prefix = `${selectedPrefix}${ordinal}`;
    const availableBytes = Math.max(
      8,
      TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8'),
    );
    const trimmedLabel = optionLabel.trim() || `Option ${optionIndex + 1}`;
    const safeLabel = truncateUtf8ToByteLimit(trimmedLabel, availableBytes);
    return `${prefix}${safeLabel}`;
  }

  protected buildUserQuestionKeyboard(
    requestId: string,
    questionIndex: number,
    question: UserQuestionRequest['questions'][number],
    selectedOptionIndexes: Set<number>,
  ): {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const inline_keyboard: Array<
      Array<{ text: string; callback_data: string }>
    > = question.options.map((option, optionIndex) => {
      const isSelected = selectedOptionIndexes.has(optionIndex);
      return [
        {
          text: this.formatUserQuestionButtonLabel(
            option.label,
            optionIndex,
            question.multiSelect,
            isSelected,
          ),
          callback_data: `userq:select:${requestId}:${questionIndex}:${optionIndex}`,
        },
      ];
    });
    if (question.multiSelect) {
      const selectedCount = selectedOptionIndexes.size;
      inline_keyboard.push([
        {
          text: selectedCount > 0 ? `Done (${selectedCount})` : 'Done',
          callback_data: `userq:done:${requestId}:${questionIndex}`,
        },
      ]);
    }
    return { inline_keyboard };
  }

  protected async sendPermissionPromptMessage(input: {
    chatId: string;
    request: PermissionApprovalRequest;
    callbackId: string;
    timeoutMs: number;
    threadOpts: { message_thread_id?: number };
  }): Promise<{ message_id: number }> {
    if (!this.bot) throw new Error('Telegram bot is not connected');
    const promptHtml = renderPermissionPromptHtml(
      buildPermissionPromptParts(input.request, input.timeoutMs),
    );
    const replyMarkup = {
      inline_keyboard: permissionDecisionOptions(input.request).map((mode) => [
        {
          text: permissionButtonLabel(mode, input.request),
          callback_data: `perm:${mode}:${input.callbackId}`,
        },
      ]),
    };
    return this.bot.api
      .sendMessage(input.chatId, promptHtml, {
        ...input.threadOpts,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      })
      .catch((htmlErr) => {
        logger.warn(
          {
            requestId: input.request.requestId,
            error: this.sanitizeErrorMessage(htmlErr),
          },
          'Telegram HTML permission prompt failed; retrying as plain text',
        );
        return this.bot!.api.sendMessage(
          input.chatId,
          formatPermissionPromptText(input.request, input.timeoutMs),
          { ...input.threadOpts, reply_markup: replyMarkup },
        );
      });
  }

  protected async sendUserQuestionPromptMessage(input: {
    chatId: string;
    requestId: string;
    questionIndex: number;
    question: UserQuestionRequest['questions'][number];
    threadOpts: { message_thread_id?: number };
  }): Promise<{
    messageId: number;
    promptText: string;
    promptIsHtml: boolean;
  }> {
    if (!this.bot) throw new Error('Telegram bot is not connected');
    const htmlPrompt = renderUserQuestionPromptHtml(input.question);
    const plainPrompt = formatTelegramUserQuestionPlainText(input.question);
    const replyMarkup = this.buildUserQuestionKeyboard(
      input.requestId,
      input.questionIndex,
      input.question,
      new Set<number>(),
    );
    let promptText = htmlPrompt;
    let promptIsHtml = true;
    const sent = await this.bot.api
      .sendMessage(input.chatId, htmlPrompt, {
        ...input.threadOpts,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      })
      .catch((htmlErr) => {
        logger.warn(
          {
            requestId: input.requestId,
            questionIndex: input.questionIndex,
            error: this.sanitizeErrorMessage(htmlErr),
          },
          'Telegram HTML user question failed; retrying as plain text',
        );
        promptText = plainPrompt;
        promptIsHtml = false;
        return this.bot!.api.sendMessage(input.chatId, plainPrompt, {
          ...input.threadOpts,
          reply_markup: replyMarkup,
        });
      });
    return { messageId: sent.message_id, promptText, promptIsHtml };
  }

  protected async isTelegramApproverAuthorized(
    chatId: string,
    userId: string,
    sourceAgentFolder: string,
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'],
  ): Promise<boolean> {
    if (decisionPolicy && decisionPolicy !== 'same_channel') {
      logger.warn(
        { chatId, userId, sourceAgentFolder, decisionPolicy },
        'Permission decision denied: unsupported Telegram decision policy',
      );
      return false;
    }
    const conversationJid = `tg:${chatId}`;
    if (this.opts.isControlApproverAllowed) {
      return this.opts.isControlApproverAllowed({
        providerId: 'telegram',
        conversationJid,
        userId,
        sourceAgentFolder,
        decisionPolicy,
      });
    }
    const settings = this.opts.runtimeSettings?.();
    const binding = settings
      ? Object.values(settings.bindings || {}).find(
          (entry) => entry.agent === sourceAgentFolder,
        )
      : undefined;
    const conversation = binding
      ? settings?.conversations[binding.conversation]
      : undefined;
    const allowedIds = conversation?.controlApprovers || [];

    if (allowedIds.length === 0) {
      logger.warn(
        { chatId, userId, sourceAgentFolder },
        'Permission decision denied: Telegram control_allowlist is empty',
      );
      return false;
    }
    return allowedIds.includes(userId);
  }

  protected async resolvePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingPermissionPrompts.get(requestId);
    if (!pending || !this.bot) return;
    this.pendingPermissionPrompts.delete(requestId);
    this.pendingPermissionCallbackIds.delete(pending.callbackId);
    clearTimeout(pending.timer);
    pending.resolve(decision);

    const text = escapeTelegramHtml(
      formatPermissionReceiptText(requestId, pending.request, decision),
    );
    try {
      await this.bot.api.editMessageText(
        pending.chatId,
        pending.messageId,
        text,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        },
      );
    } catch (err) {
      logger.debug(
        { requestId, err: this.sanitizeErrorMessage(err) },
        'Failed to update Telegram permission prompt message',
      );
    }
  }

  protected async refreshUserQuestionPrompt(
    pending: PendingUserQuestionState,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.editMessageText(
        pending.chatId,
        pending.messageId,
        pending.promptText,
        {
          ...(pending.promptIsHtml ? { parse_mode: 'HTML' as const } : {}),
          reply_markup: this.buildUserQuestionKeyboard(
            pending.requestId,
            pending.questionIndex,
            {
              question: pending.questionText,
              header: pending.questionHeader,
              options: pending.optionLabels.map((label) => ({
                label,
                description: '',
              })),
              multiSelect: pending.multiSelect,
            },
            pending.selectedOptionIndexes,
          ),
        },
      );
    } catch (err) {
      logger.debug(
        {
          requestId: pending.requestId,
          questionIndex: pending.questionIndex,
          err: this.sanitizeErrorMessage(err),
        },
        'Failed to refresh Telegram user question keyboard',
      );
    }
  }

  protected async finalizeUserQuestionPrompt(
    pending: PendingUserQuestionState,
    selection: string | string[],
    answeredBy?: string,
    reason?: string,
  ): Promise<void> {
    this.pendingUserQuestions.delete(
      this.pendingUserQuestionKey(pending.requestId, pending.questionIndex),
    );
    clearTimeout(pending.timer);
    pending.resolve({ selected: selection, answeredBy });

    if (!this.bot) return;
    const selectionText = Array.isArray(selection)
      ? selection.join(', ')
      : selection;
    const actor = answeredBy ? ` (by ${answeredBy})` : '';
    const text = escapeTelegramHtml(
      selectionText
        ? `✅ ${pending.questionHeader} · ${selectionText}${actor}`
        : `⌛ ${pending.questionHeader} · ${reason || 'no answer'}`,
    );
    try {
      await this.bot.api.editMessageText(
        pending.chatId,
        pending.messageId,
        text,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        },
      );
    } catch (err) {
      logger.debug(
        {
          requestId: pending.requestId,
          questionIndex: pending.questionIndex,
          err: this.sanitizeErrorMessage(err),
        },
        'Failed to finalize Telegram user question prompt',
      );
    }
  }

  protected startPolling(): void {
    if (!this.bot || this.isStopping) return;
    void this.startPollingWithLease();
  }

  private async startPollingWithLease(): Promise<void> {
    if (
      !this.bot ||
      this.isStopping ||
      this.pollingLease ||
      this.pollingStartInFlight
    ) {
      return;
    }
    this.pollingStartInFlight = true;
    if (!this.botToken.trim()) {
      this.pollingStartInFlight = false;
      logger.error('Telegram polling cannot start without a bot token');
      return;
    }
    const leaseKey = `telegram:poll:${createHash('sha256').update(this.botToken).digest('hex').slice(0, TELEGRAM_POLL_LEASE_HASH_CHARS)}`;
    let lease;
    try {
      lease = await this.opts.runtimeLease?.tryAcquire(leaseKey);
    } catch (err) {
      this.pollingStartInFlight = false;
      logger.warn(
        { err, leaseKey },
        'Telegram polling lease acquisition failed; scheduling retry',
      );
      this.schedulePollingRetry();
      return;
    }
    if (!lease && this.opts.runtimeLease) {
      this.pollingStartInFlight = false;
      logger.warn(
        { leaseKey },
        'Telegram polling lease is held by another runtime; skipping poller start',
      );
      this.schedulePollingRetry();
      return;
    }
    this.pollingLease = lease ?? null;
    lease?.onLost?.((err) => {
      if (this.pollingLease !== lease) return;
      this.pollingLease = null;
      if (this.isStopping) return;
      logger.warn(
        { err, leaseKey },
        'Telegram polling lease connection was lost; scheduling retry',
      );
      this.schedulePollingRetry();
    });

    if (this.isTelegramBotRunning()) {
      this.pollingStartInFlight = false;
      logger.info(
        { leaseKey },
        'Telegram poller already running; retaining polling lease',
      );
      return;
    }

    const pollingRun = this.bot.start({
      onStart: (botInfo) => {
        logger.info(
          { username: botInfo.username, id: botInfo.id },
          'Telegram bot connected',
        );
        logger.info(
          {
            username: botInfo.username,
            hint: 'Send /chatid to the bot to get a chat registration ID',
          },
          'Telegram bot connection hint',
        );
      },
    });
    if (!pollingRun || typeof pollingRun.then !== 'function') {
      this.pollingStartInFlight = false;
      return;
    }

    Promise.resolve(pollingRun)
      .then(() => {
        this.pollingStartInFlight = false;
        if (this.isTelegramBotRunning()) {
          logger.info(
            { leaseKey },
            'Telegram poller remains active after duplicate start; retaining polling lease',
          );
          return;
        }
        void this.releasePollingLease();
        if (this.isStopping) return;
        logger.warn('Telegram polling stopped unexpectedly');
        this.schedulePollingRetry();
      })
      .catch((err) => {
        this.pollingStartInFlight = false;
        void this.releasePollingLease();
        if (this.isStopping) return;
        logger.error({ err }, 'Telegram polling failed');
        this.schedulePollingRetry();
      });
  }

  protected async releasePollingLease(): Promise<void> {
    const lease = this.pollingLease;
    this.pollingLease = null;
    await lease?.release();
  }

  private isTelegramBotRunning(): boolean {
    return this.bot?.isRunning?.() ?? false;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the downloaded file path and stable storage ref, or null on failure.
   */
  protected async downloadFile(
    fileId: string,
    workspaceFolder: string,
    filename: string,
  ): Promise<TelegramDownloadedFile | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }
      const safeFilePath = this.sanitizeTelegramFilePath(file.file_path);
      if (!safeFilePath) {
        logger.warn(
          { fileId, filePath: '[unsafe-file-path]' },
          'Rejected unsafe Telegram file path',
        );
        return null;
      }

      const groupDir = resolveWorkspaceFolderPath(workspaceFolder);
      const attachDir = path.join(groupDir, 'attachments');
      ensurePrivateDirSync(attachDir);

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(safeFilePath);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);
      const storageRef = path.posix.join('attachments', finalName);

      const encodedPath = safeFilePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${encodedPath}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const wrote = await writeTelegramFetchResponseToFile(resp, destPath);
      if (!wrote) return null;

      logger.info({ fileId, storageRef }, 'Telegram file downloaded');
      return { filePath: destPath, storageRef };
    } catch (err) {
      logger.error(
        { fileId, error: this.sanitizeErrorMessage(err) },
        'Failed to download Telegram file',
      );
      return null;
    }
  }
}

function formatTelegramUserQuestionPlainText(
  question: UserQuestionRequest['questions'][number],
): string {
  return [
    `❓ ${question.header}`,
    question.question,
    '',
    ...question.options.map(
      (option, optionIndex) =>
        `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`,
    ),
  ].join('\n');
}
