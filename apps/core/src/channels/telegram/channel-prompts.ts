import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';

import { resolveGroupFolderPath } from '../../platform/group-folder.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import { writeTelegramFetchResponseToFile } from '../telegram-file-download.js';
import {
  formatPermissionPromptText as formatSharedPermissionPromptText,
  formatPermissionReceiptText,
} from '../permission-interaction.js';

import { TelegramChannelState } from './channel-state.js';

const TELEGRAM_POLL_LEASE_HASH_CHARS = 24;
import {
  PendingUserQuestionState,
  TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES,
  truncateText,
  truncateUtf8ToByteLimit,
} from './channel-shared.js';

export abstract class TelegramChannelPrompts extends TelegramChannelState {
  protected formatPermissionPromptText(
    request: PermissionApprovalRequest,
    timeoutMs: number,
  ): string {
    return formatSharedPermissionPromptText(request, timeoutMs);
  }

  protected formatPermissionToolInputLines(
    request: PermissionApprovalRequest,
  ): string[] {
    if (!request.toolInput || typeof request.toolInput !== 'object') return [];
    const input = request.toolInput;
    if (
      request.toolName === 'Bash' &&
      typeof input.command === 'string' &&
      input.command.trim()
    ) {
      return [`Command: \`${truncateText(input.command.trim(), 300)}\``];
    }
    if (request.toolName === 'Edit' || request.toolName === 'Write') {
      const lines: string[] = [];
      if (typeof input.file_path === 'string' && input.file_path.trim()) {
        lines.push(`File: ${truncateText(input.file_path.trim(), 250)}`);
      }
      if (typeof input.old_string === 'string' && input.old_string.trim()) {
        lines.push(`Replacing: ${truncateText(input.old_string.trim(), 150)}`);
      }
      if (typeof input.new_string === 'string' && input.new_string.trim()) {
        lines.push(`With: ${truncateText(input.new_string.trim(), 150)}`);
      }
      if (lines.length > 0) return lines;
    }
    try {
      return [`Input: ${truncateText(JSON.stringify(input), 300)}`];
    } catch {
      return ['Input: [unserializable]'];
    }
  }

  protected pendingUserQuestionKey(
    requestId: string,
    questionIndex: number,
  ): string {
    return `${requestId}:${questionIndex}`;
  }

  protected formatUserQuestionPromptText(
    request: UserQuestionRequest,
    question: UserQuestionRequest['questions'][number],
    timeoutMs: number,
  ): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    const lines = [
      `❓ ${question.header}`,
      `Source: ${truncateText(request.sourceAgentFolder, 80)}`,
    ];
    if (request.threadId) {
      lines.push(`Thread: ${truncateText(request.threadId, 80)}`);
    }
    lines.push(question.question, '');
    question.options.forEach((option, optionIndex) => {
      const description = option.description
        ? ` — ${truncateText(option.description, 180)}`
        : '';
      lines.push(`${optionIndex + 1}. ${option.label}${description}`);
      if (option.preview) {
        lines.push(`  Preview: ${truncateText(option.preview, 180)}`);
      }
    });
    lines.push('');
    if (question.multiSelect) {
      lines.push('Select one or more options, then tap Done.');
    } else {
      lines.push('Select one option.');
    }
    lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
    return lines.join('\n');
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

    const text = formatPermissionReceiptText(
      requestId,
      pending.request,
      decision,
    );
    try {
      await this.bot.api.editMessageText(
        pending.chatId,
        pending.messageId,
        text,
        {
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
    const status = reason || 'answered';
    const actor = answeredBy ? ` by ${answeredBy}` : '';
    const text = `❓ ${pending.questionHeader}\n${pending.questionText}\n\nAnswer: ${selectionText || '[none]'}\nStatus: ${status}${actor}`;
    try {
      await this.bot.api.editMessageText(
        pending.chatId,
        pending.messageId,
        text,
        {
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
   * Returns the absolute attachment path on disk or null if the download fails.
   */
  protected async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
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

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      await fs.promises.mkdir(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(safeFilePath);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

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

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return destPath;
    } catch (err) {
      logger.error(
        { fileId, error: this.sanitizeErrorMessage(err) },
        'Failed to download Telegram file',
      );
      return null;
    }
  }
}
