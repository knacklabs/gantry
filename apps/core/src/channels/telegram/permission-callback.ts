import {
  recoverDurablePermissionDecision,
  type DurablePermissionRecoveryReceipt,
  type DurablePermissionInteractionContext,
} from '../../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalDecisionMode } from '../../domain/types.js';
import { formatPermissionReceiptText } from '../permission-interaction.js';
import { escapeTelegramHtml } from './html-render.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';

interface TelegramPermissionCallbackContext {
  callbackQuery?: {
    from?: {
      id?: number | string;
      first_name?: string;
      username?: string;
    };
    message?: {
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: number | string };
    };
  };
  chat?: { id?: number | string };
  from?: {
    id?: number | string;
    first_name?: string;
    username?: string;
  };
  api: {
    deleteMessage(chatId: string, messageId: number): Promise<unknown>;
    editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      options: Record<string, unknown>,
    ): Promise<unknown>;
    sendMessage(
      chatId: string,
      text: string,
      options: Record<string, unknown>,
    ): Promise<unknown>;
  };
  answerCallbackQuery: (input: {
    text: string;
    show_alert: boolean;
  }) => Promise<unknown>;
}

export async function resolveDurableTelegramPermissionCallback(input: {
  context: TelegramPermissionCallbackContext;
  appId: string;
  providerAlias: string;
  mode: PermissionApprovalDecisionMode;
  sanitizeErrorMessage: (err: unknown) => string;
  isAuthorized: (
    approvalContextJid: string,
    userId: string,
    durable: DurablePermissionInteractionContext,
  ) => Promise<boolean>;
}): Promise<void> {
  const callbackQuery = input.context.callbackQuery;
  const message = callbackQuery?.message;
  const callbackChatId =
    message?.chat?.id?.toString() || input.context.chat?.id?.toString() || '';
  const messageId = message?.message_id;
  const userId =
    callbackQuery?.from?.id?.toString() ||
    input.context.from?.id?.toString() ||
    '';
  if (!callbackChatId || messageId === undefined || !userId) {
    await inactive(input.context);
    return;
  }
  await recoverDurablePermissionDecision({
    locator: {
      kind: 'message',
      appId: input.appId,
      provider: 'telegram',
      conversationId: callbackChatId,
      externalMessageId: String(messageId),
      ...(message?.message_thread_id === undefined
        ? {}
        : { threadId: String(message.message_thread_id) }),
      providerAlias: input.providerAlias,
    },
    surfaceJid: `tg:${callbackChatId}`,
    incomingMode: input.mode,
    incomingApprover: userId,
    authorize: (durable) =>
      durable.approvalContextJid
        ? input.isAuthorized(durable.approvalContextJid, userId, durable)
        : Promise.resolve(false),
    terminalize: (receipt) =>
      terminalizeTelegramPermissionPrompt({
        context: input.context,
        chatId: callbackChatId,
        messageId,
        threadId:
          receipt.status === 'resolved'
            ? (receipt.context.threadId ?? undefined)
            : message?.message_thread_id?.toString(),
        receipt,
        sanitizeErrorMessage: input.sanitizeErrorMessage,
      }),
    feedback: async (text) => {
      await input.context.answerCallbackQuery({
        text,
        show_alert: text !== 'Decision recorded.',
      });
    },
  });
}

async function terminalizeTelegramPermissionPrompt(input: {
  context: TelegramPermissionCallbackContext;
  chatId: string;
  messageId: number;
  threadId?: string;
  receipt: DurablePermissionRecoveryReceipt;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<boolean> {
  const approved =
    input.receipt.status === 'resolved' &&
    input.receipt.decision.approved &&
    input.receipt.decision.mode !== 'cancel';
  if (approved) {
    try {
      await input.context.api.deleteMessage(input.chatId, input.messageId);
      return true;
    } catch {
      // Fall through to the visible receipt replacement.
    }
  }
  const text = escapeTelegramHtml(
    input.receipt.status === 'expired' || !input.receipt.request
      ? (input.receipt.text ?? 'Permission resolved.')
      : formatPermissionReceiptText(
          input.receipt.request.requestId,
          input.receipt.request,
          input.receipt.decision,
        ),
  );
  try {
    await input.context.api.editMessageText(
      input.chatId,
      input.messageId,
      text,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      },
    );
    return true;
  } catch {
    try {
      await input.context.api.sendMessage(input.chatId, text, {
        parse_mode: 'HTML',
        ...telegramThreadOptionsFromString(input.threadId),
      });
      return true;
    } catch (err) {
      input.sanitizeErrorMessage(err);
      return false;
    }
  }
}

async function inactive(
  context: TelegramPermissionCallbackContext,
): Promise<void> {
  await context.answerCallbackQuery({
    text: 'Permission request is no longer active.',
    show_alert: true,
  });
}
