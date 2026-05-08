import type { Api } from 'grammy';

import { logger } from '../../infrastructure/logging/logger.js';

type TelegramSendMessageOptions = { message_thread_id?: number };

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err !== 'object' || err === null) return String(err);
  const candidate = err as {
    description?: unknown;
    message?: unknown;
    error?: unknown;
    response?: { description?: unknown };
  };
  const values = [
    candidate.description,
    candidate.message,
    candidate.error,
    candidate.response?.description,
  ].filter((value): value is string => typeof value === 'string');
  return values.join(' | ');
}

function isTelegramMarkdownParseFailure(err: unknown): boolean {
  const message = errorText(err).toLowerCase();
  if (!message) return false;
  return (
    message.includes("can't parse entities") ||
    message.includes('cant parse entities') ||
    message.includes('parse entities')
  );
}

export async function sendTelegramPlannedChunk(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    sendOptions?: TelegramSendMessageOptions;
    plainText?: string;
    allowPlainTextFallback?: boolean;
    forcePlainText?: boolean;
  } = {},
): Promise<{ messageId?: number; usedPlainText: boolean }> {
  const sendOptions = options.sendOptions ?? {};
  const plainText = options.plainText ?? text;
  if (options.forcePlainText) {
    const sent = await api.sendMessage(chatId, plainText, sendOptions);
    return {
      messageId: (sent as { message_id?: number })?.message_id,
      usedPlainText: true,
    };
  }

  try {
    const sent = await api.sendMessage(chatId, text, {
      ...sendOptions,
      parse_mode: 'MarkdownV2',
    });
    return {
      messageId: (sent as { message_id?: number })?.message_id,
      usedPlainText: false,
    };
  } catch (err) {
    if (
      !options.allowPlainTextFallback ||
      !isTelegramMarkdownParseFailure(err)
    ) {
      throw err;
    }
    logger.warn(
      { err: errorText(err) },
      'Telegram MarkdownV2 chunk parse failed; retrying with plain text',
    );
    const sent = await api.sendMessage(chatId, plainText, sendOptions);
    return {
      messageId: (sent as { message_id?: number })?.message_id,
      usedPlainText: true,
    };
  }
}
