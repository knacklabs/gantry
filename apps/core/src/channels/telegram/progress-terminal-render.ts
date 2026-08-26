import type { ProgressUpdateOptions } from '../../domain/types.js';
import {
  editTelegramMessage,
  sendTelegramMessageWithResult,
  type TelegramSendMessageOptions,
} from './channel-shared.js';
import { telegramJobNotificationMessage } from './message-action-affordances.js';
import { TELEGRAM_MESSAGE_MAX_LENGTH } from './text-limits.js';

export function terminalTelegramProgressMessage(
  options: Pick<ProgressUpdateOptions, 'done' | 'jobNotificationView'>,
): { text: string } | undefined {
  if (!options.done || !options.jobNotificationView) return undefined;
  const message = telegramJobNotificationMessage(options.jobNotificationView);
  return message.text.length <= TELEGRAM_MESSAGE_MAX_LENGTH
    ? message
    : undefined;
}

export function isTelegramHtmlParseError(err: unknown): boolean {
  if (typeof err === 'string') return /parse entities|parse error/i.test(err);
  if (!err || typeof err !== 'object') return false;
  const candidate = err as {
    message?: unknown;
    description?: unknown;
    response?: { description?: unknown };
  };
  return [
    candidate.message,
    candidate.description,
    candidate.response?.description,
  ].some(
    (value) =>
      typeof value === 'string' && /parse entities|parse error/i.test(value),
  );
}

export async function sendTerminalTelegramProgressMessage(input: {
  api: Parameters<typeof sendTelegramMessageWithResult>[0];
  chatId: string;
  text: string;
  fallbackText: string;
  sendOptions: TelegramSendMessageOptions;
}): Promise<{ messageId: number | undefined; text: string }> {
  try {
    const sent = await input.api.sendMessage(input.chatId, input.text, {
      parse_mode: 'HTML',
      ...input.sendOptions,
    });
    return {
      messageId: (sent as { message_id?: number }).message_id,
      text: input.text,
    };
  } catch (err) {
    if (!isTelegramHtmlParseError(err)) throw err;
    return {
      messageId: await sendTelegramMessageWithResult(
        input.api,
        input.chatId,
        input.fallbackText,
        input.sendOptions,
      ),
      text: input.fallbackText,
    };
  }
}

export function sendTelegramProgressReplacementMessage(input: {
  api: Parameters<typeof sendTelegramMessageWithResult>[0];
  chatId: string;
  text: string;
  fallbackText: string;
  sendOptions: TelegramSendMessageOptions;
  terminal: boolean;
}): Promise<number | undefined> {
  return input.terminal
    ? sendTerminalTelegramProgressMessage(input).then(
        ({ messageId }) => messageId,
      )
    : sendTelegramMessageWithResult(
        input.api,
        input.chatId,
        input.text,
        input.sendOptions,
      );
}

export async function editTelegramProgressMessage(input: {
  api: Parameters<typeof editTelegramMessage>[0];
  chatId: string;
  messageId: number;
  text: string;
  terminalFallbackText?: string;
  editReplyMarkup: Record<string, unknown>;
}): Promise<void> {
  if (input.terminalFallbackText === undefined) {
    return editTelegramMessage(
      input.api,
      input.chatId,
      input.messageId,
      input.text,
      {},
      input.editReplyMarkup,
    );
  }
  try {
    await input.api.editMessageText(input.chatId, input.messageId, input.text, {
      parse_mode: 'HTML',
      ...input.editReplyMarkup,
    });
  } catch (err) {
    if (!isTelegramHtmlParseError(err)) throw err;
    await editTelegramMessage(
      input.api,
      input.chatId,
      input.messageId,
      input.terminalFallbackText,
      {},
      input.editReplyMarkup,
    );
  }
}
