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

import { TelegramChannelPolling } from './channel-polling.js';

import {
  PendingUserQuestionState,
  TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  splitTelegramTextByCodeUnits,
  truncateUtf8ToByteLimit,
} from './channel-shared.js';
import {
  resolveDurableTelegramUserQuestionOtherReply,
  sendTelegramUserQuestionOtherReplyNotice,
} from './user-question-other-recovery.js';

export interface TelegramDownloadedFile {
  filePath: string;
  storageRef: string;
}

export abstract class TelegramChannelPrompts extends TelegramChannelPolling {
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
    inline_keyboard.push([
      {
        text: '✏️ Other',
        callback_data: `userq:other:${requestId}:${questionIndex}`,
      },
    ]);
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
    const parts = buildPermissionPromptParts(input.request, input.timeoutMs);
    const promptHtml = renderPermissionPromptHtml(parts);
    const replyMarkup = {
      inline_keyboard: permissionDecisionOptions(input.request).map((mode) => [
        {
          text: permissionButtonLabel(mode, input.request),
          callback_data: `perm:${mode}:${input.callbackId}`,
        },
      ]),
    };
    if (promptHtml.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
      await this.sendSplitPermissionReviewMessages({
        chatId: input.chatId,
        request: input.request,
        timeoutMs: input.timeoutMs,
        threadOpts: input.threadOpts,
      });
      return this.bot.api.sendMessage(
        input.chatId,
        renderPermissionPromptHtml({
          ...parts,
          bodyLines: ['Review the approval details above before choosing.'],
        }),
        {
          ...input.threadOpts,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: replyMarkup,
        },
      );
    }
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
        const plainPrompt = formatPermissionPromptText(
          input.request,
          input.timeoutMs,
        );
        if (plainPrompt.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
          return this.sendSplitPermissionReviewMessages({
            chatId: input.chatId,
            request: input.request,
            timeoutMs: input.timeoutMs,
            threadOpts: input.threadOpts,
          }).then(() =>
            this.bot!.api.sendMessage(
              input.chatId,
              'Review the approval details above before choosing.',
              { ...input.threadOpts, reply_markup: replyMarkup },
            ),
          );
        }
        return this.bot!.api.sendMessage(input.chatId, plainPrompt, {
          ...input.threadOpts,
          reply_markup: replyMarkup,
        });
      });
  }

  private async sendSplitPermissionReviewMessages(input: {
    chatId: string;
    request: PermissionApprovalRequest;
    timeoutMs: number;
    threadOpts: { message_thread_id?: number };
  }): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot is not connected');
    const promptText = formatPermissionPromptText(
      input.request,
      input.timeoutMs,
      { budget: Number.POSITIVE_INFINITY },
    );
    for (const chunk of splitTelegramTextByCodeUnits(
      promptText,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    )) {
      await this.bot.api.sendMessage(input.chatId, chunk, {
        ...input.threadOpts,
        link_preview_options: { is_disabled: true },
      });
    }
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

  /**
   * Correlate an inbound text reply to a pending "Other" free-text prompt.
   * Returns true when the reply was consumed (handled or stale), false when it
   * should fall through to normal message handling.
   */
  protected async tryResolveUserQuestionOtherReply(input: {
    chatId: string;
    replyToMessageId: number;
    text: string;
    userId: string;
    answeredBy: string;
  }): Promise<boolean> {
    const key = `${input.chatId}:${input.replyToMessageId}`;
    const entry = this.pendingUserQuestionOtherPrompts.get(key);
    if (!entry) return false;
    const pending = this.pendingUserQuestions.get(
      this.pendingUserQuestionKey(entry.requestId, entry.questionIndex),
    );
    if (!pending) {
      const recovered = await resolveDurableTelegramUserQuestionOtherReply({
        chatId: input.chatId,
        requestId: entry.requestId,
        questionIndex: entry.questionIndex,
        text: input.text,
        userId: input.userId,
        answeredBy: input.answeredBy,
        isApproverAuthorized: (chatId, userId, sourceAgentFolder) =>
          this.isTelegramApproverAuthorized(chatId, userId, sourceAgentFolder),
        sendNotice: (chatId, text) =>
          this.sendUserQuestionOtherReplyNotice(chatId, text),
      });
      if (recovered.deletePrompt) {
        this.pendingUserQuestionOtherPrompts.delete(key);
      }
      return true;
    }
    const authorized = input.userId
      ? await this.isTelegramApproverAuthorized(
          pending.chatId,
          input.userId,
          pending.sourceAgentFolder,
        )
      : false;
    if (!authorized) {
      // Leave the prompt active so a control approver can still reply.
      await this.sendUserQuestionOtherReplyNotice(
        input.chatId,
        'Only a conversation control approver can answer.',
      );
      return true;
    }
    const answer = input.text.trim();
    if (!answer) {
      await this.sendUserQuestionOtherReplyNotice(
        input.chatId,
        'Answer cannot be empty.',
      );
      return true;
    }
    this.pendingUserQuestionOtherPrompts.delete(key);
    const selection: string | string[] = pending.multiSelect
      ? [
          ...[...pending.selectedOptionIndexes]
            .sort((a, b) => a - b)
            .map((index) => pending.optionLabels[index])
            .filter(Boolean),
          answer,
        ]
      : answer;
    await this.finalizeUserQuestionPrompt(
      pending,
      selection,
      input.answeredBy,
      'answered via Telegram',
    );
    return true;
  }

  private async sendUserQuestionOtherReplyNotice(
    chatId: string,
    text: string,
  ): Promise<void> {
    await sendTelegramUserQuestionOtherReplyNotice({
      bot: this.bot,
      chatId,
      text,
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
    });
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
