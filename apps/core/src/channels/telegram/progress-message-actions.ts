import type { ProgressUpdateOptions } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  editTelegramMessage,
  sendTelegramMessageWithResult,
  type ActiveProgressState,
  type TelegramSendMessageOptions,
} from './channel-shared.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';

export function progressActionOptions(options: ProgressUpdateOptions): {
  sendOptions: TelegramSendMessageOptions;
  editReplyMarkup: Record<string, unknown>;
} {
  const actionReplyMarkup = options.actionAffordances
    ? telegramActionReplyMarkup(options.actionAffordances)
    : undefined;
  return {
    sendOptions: actionReplyMarkup ? { reply_markup: actionReplyMarkup } : {},
    editReplyMarkup: actionReplyMarkup
      ? { reply_markup: actionReplyMarkup }
      : options.done
        ? { reply_markup: { inline_keyboard: [] } }
        : {},
  };
}

export async function clearProgressActions(input: {
  api: Parameters<typeof editTelegramMessage>[0];
  chatId: string;
  messageId?: number;
  text: string;
  editReplyMarkup: Record<string, unknown>;
}): Promise<void> {
  if (!input.messageId) return;
  await editTelegramMessage(
    input.api,
    input.chatId,
    input.messageId,
    input.text,
    {},
    input.editReplyMarkup,
  );
}

export async function sendNewProgressMessage(input: {
  api: Parameters<typeof sendTelegramMessageWithResult>[0];
  activeProgressMessages: Map<string, ActiveProgressState>;
  persistProgressMessages: () => void;
  chatId: string | number;
  key: string;
  jid: string;
  text: string;
  options: ProgressUpdateOptions;
  sendOptions: TelegramSendMessageOptions;
  threadId?: number;
}): Promise<void> {
  const messageId = await sendTelegramMessageWithResult(
    input.api,
    input.chatId,
    input.text,
    input.sendOptions,
  );
  if (!input.options.done) {
    input.activeProgressMessages.set(input.key, {
      chatId: String(input.chatId),
      threadId: input.threadId,
      messageId,
      lastText: input.text,
      ...(input.options.generation !== undefined
        ? { generation: input.options.generation }
        : {}),
    });
    input.persistProgressMessages();
  }
  logger.info(
    {
      jid: input.jid,
      key: input.key,
      progressText: input.text,
      done: input.options.done ?? false,
      generation: input.options.generation,
      messageId,
      storedHandle: !input.options.done,
    },
    'Progress lifecycle telegram sent new message',
  );
}
