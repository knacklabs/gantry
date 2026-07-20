import path from 'path';
import { InputFile } from 'grammy';
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
  formatPermissionPromptPartsText,
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
  telegramThreadOptionsFromString,
  truncateUtf8ToByteLimit,
} from './channel-shared.js';
import { claimAndSettleTelegramPermissionPrompt } from './permission-prompt-settlement.js';
const TELEGRAM_PERMISSION_FULL_VIEW_INLINE_MAX = 3200;
export interface TelegramDownloadedFile {
  filePath: string;
  storageRef: string;
}
export abstract class TelegramChannelPrompts extends TelegramChannelPolling {
  protected pendingUserQuestionKey(
    appId: string,
    sourceAgentFolder: string,
    requestId: string,
    questionIndex: number,
  ): string {
    return JSON.stringify([appId, sourceAgentFolder, requestId, questionIndex]);
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
    callbackId: string,
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
          callback_data: `userq:select:${callbackId}:${optionIndex}`,
        },
      ];
    });
    if (question.multiSelect) {
      const selectedCount = selectedOptionIndexes.size;
      inline_keyboard.push([
        {
          text: selectedCount > 0 ? `Done (${selectedCount})` : 'Done',
          callback_data: `userq:done:${callbackId}`,
        },
      ]);
    }
    inline_keyboard.push([
      {
        text: '✏️ Other',
        callback_data: `userq:other:${callbackId}`,
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
    const promptHtmlWithFullView = renderPermissionPromptHtml(parts, {
      includeFullView: Boolean(parts.fullView),
    });
    const includeInlineFullView = Boolean(
      parts.fullView &&
      parts.fullView.content.length <=
        TELEGRAM_PERMISSION_FULL_VIEW_INLINE_MAX &&
      promptHtmlWithFullView.length <= TELEGRAM_MESSAGE_MAX_LENGTH,
    );
    const fullViewSent =
      parts.fullView && !includeInlineFullView
        ? await this.sendPermissionFullViewDocument({
            chatId: input.chatId,
            request: input.request,
            fullView: parts.fullView,
            threadOpts: input.threadOpts,
          })
        : false;
    if (parts.fullView && !includeInlineFullView && !fullViewSent) {
      const blockedParts = {
        ...parts,
        bodyLines: [
          ...parts.bodyLines,
          `${parts.fullView.label}: could not be delivered for review.`,
          'Approval unavailable until the full details can be reviewed.',
        ],
        fullView: undefined,
      };
      const blockedText = formatPermissionPromptPartsText(blockedParts);
      if (blockedText.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
        await this.sendSplitPermissionReviewMessages({
          chatId: input.chatId,
          promptText: blockedText,
          threadOpts: input.threadOpts,
        });
        await this.bot.api.sendMessage(
          input.chatId,
          'Approval unavailable: the full details could not be delivered for review.',
          {
            ...input.threadOpts,
            link_preview_options: { is_disabled: true },
          },
        );
      } else {
        await this.bot.api.sendMessage(input.chatId, blockedText, {
          ...input.threadOpts,
          link_preview_options: { is_disabled: true },
        });
      }
      throw new Error(
        'Telegram approval full view could not be delivered for review',
      );
    }
    const promptParts =
      parts.fullView && !includeInlineFullView
        ? {
            ...parts,
            bodyLines: [
              ...parts.bodyLines,
              `${parts.fullView.label}: ${
                fullViewSent
                  ? 'sent above for review.'
                  : 'too large for inline full view.'
              }`,
            ],
            fullView: undefined,
          }
        : parts;
    const promptHtml = includeInlineFullView
      ? promptHtmlWithFullView
      : renderPermissionPromptHtml(promptParts);
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
        promptText: formatPermissionPromptPartsText(promptParts),
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
        const plainPromptText = formatPermissionPromptPartsText(promptParts);
        if (plainPromptText.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
          return this.sendSplitPermissionReviewMessages({
            chatId: input.chatId,
            promptText: plainPromptText,
            threadOpts: input.threadOpts,
          }).then(() =>
            this.bot!.api.sendMessage(
              input.chatId,
              'Review the approval details above before choosing.',
              { ...input.threadOpts, reply_markup: replyMarkup },
            ),
          );
        }
        return this.bot!.api.sendMessage(input.chatId, plainPromptText, {
          ...input.threadOpts,
          reply_markup: replyMarkup,
        });
      });
  }
  private async sendSplitPermissionReviewMessages(input: {
    chatId: string;
    promptText: string;
    threadOpts: { message_thread_id?: number };
  }): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot is not connected');
    for (const chunk of splitTelegramTextByCodeUnits(
      input.promptText,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    )) {
      await this.bot.api.sendMessage(input.chatId, chunk, {
        ...input.threadOpts,
        link_preview_options: { is_disabled: true },
      });
    }
  }
  private async sendPermissionFullViewDocument(input: {
    chatId: string;
    request: PermissionApprovalRequest;
    fullView: NonNullable<
      ReturnType<typeof buildPermissionPromptParts>['fullView']
    >;
    threadOpts: { message_thread_id?: number };
  }): Promise<boolean> {
    if (!this.bot) throw new Error('Telegram bot is not connected');
    // The details belong next to the prompt: same chat, same thread. The
    // prompt is already visible there, so a private copy adds no privacy.
    const content = Buffer.from(input.fullView.content, 'utf8');
    try {
      const result = await this.bot.api.sendDocument(
        input.chatId,
        new InputFile(content, input.fullView.filename),
        {
          ...input.threadOpts,
          caption: [
            input.fullView.filename,
            `Full details for: ${input.request.displayName ?? input.request.title ?? input.request.toolName}`,
          ]
            .join('\n')
            .slice(0, 1024),
        },
      );
      return result.message_id !== undefined;
    } catch {
      return false;
    }
  }
  private telegramConversationMatchesChat(
    conversation: { providerAccount: string; externalId: string } | undefined,
    providerAccounts: Record<string, { provider: string } | undefined>,
    providerAccountId: string | undefined,
    chatId: string,
  ): boolean {
    if (!conversation || conversation.providerAccount !== providerAccountId)
      return false;
    const connection = providerAccounts[conversation.providerAccount];
    if (connection?.provider !== 'telegram') return false;
    const externalId = conversation.externalId.trim();
    return externalId === chatId || externalId === `tg:${chatId}`;
  }
  protected async sendUserQuestionPromptMessage(input: {
    chatId: string;
    requestId: string;
    questionIndex: number;
    callbackId: string;
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
      input.callbackId,
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
    threadId?: string,
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
        providerAccountId: this.opts.providerAccountId,
        agentId: this.opts.agentId,
        conversationJid,
        threadId,
        userId,
        sourceAgentFolder,
        decisionPolicy,
      });
    }
    const settings = this.opts.runtimeSettings?.();
    const binding = settings
      ? Object.values(settings.bindings || {}).find(
          (entry) =>
            entry.agent === sourceAgentFolder &&
            this.telegramConversationMatchesChat(
              settings.conversations[entry.conversation],
              settings.providerAccounts,
              this.opts.providerAccountId,
              chatId,
            ),
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
  protected async claimAndResolvePermissionPrompt(
    providerAlias: string,
    mode: NonNullable<PermissionApprovalDecision['mode']>,
    approverRef: string,
    reason: string,
  ): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'> {
    return claimAndSettleTelegramPermissionPrompt({
      providerAlias,
      mode,
      approverRef,
      reason,
      pendingPrompts: this.pendingPermissionPrompts,
      api: this.bot?.api ?? null,
      sanitizeErrorMessage: (err) => this.sanitizeErrorMessage(err),
    });
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
            pending.callbackId,
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
      this.pendingUserQuestionKey(
        pending.appId,
        pending.sourceAgentFolder,
        pending.requestId,
        pending.questionIndex,
      ),
    );
    this.pendingUserQuestionCallbackIds.delete(pending.callbackId);
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
      this.pendingUserQuestionKey(
        entry.appId,
        entry.sourceAgentFolder,
        entry.requestId,
        entry.questionIndex,
      ),
    );
    if (!pending) {
      this.pendingUserQuestionOtherPrompts.delete(key);
      return false;
    }
    const authorized = input.userId
      ? await this.isTelegramApproverAuthorized(
          pending.chatId,
          input.userId,
          pending.sourceAgentFolder,
        )
      : false;
    if (!authorized) {
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
    if (!this.bot) return;
    try {
      await this.bot.api.sendMessage(chatId, text);
    } catch (err) {
      logger.debug(
        { chatId, err: this.sanitizeErrorMessage(err) },
        'Failed to send Telegram user question reply notice',
      );
    }
  }
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
