import type { Api, Context } from 'grammy';
import type { StreamFlavor } from '@grammyjs/stream';
import { streamApi } from '@grammyjs/stream';

import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { ChannelOpts } from '../channel-provider.js';
import { parseTextStyles } from '../../text-styles.js';

export type TelegramChannelOpts = ChannelOpts;

export const TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY = 2;
export const TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX = 512;
export const TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS = 5000;
export const TELEGRAM_DRAFT_MAX_LENGTH = 4096;
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
export const TELEGRAM_STREAM_CHUNK_MAX_LENGTH = 3500;
export const TELEGRAM_GROUP_EDIT_INTERVAL_MS = 900;
export const TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES = 56;
// Keep question timeout aligned with permission approvals for now.
// This can be split into a separate config knob later if UX needs diverge.
export const TELEGRAM_USER_QUESTION_TIMEOUT_MS = PERMISSION_APPROVAL_TIMEOUT_MS;
export const TELEGRAM_PERMISSION_CALLBACK_PATTERN =
  /^perm:(allow_once|allow_job_policy|allow_persistent_rule|cancel|approve|deny):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/;
export const TELEGRAM_USER_QUESTION_CALLBACK_PATTERN =
  /^userq:(select|done):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127}):(\d+)(?::(\d+))?$/;

export type TelegramContext = StreamFlavor<Context>;
export type TelegramStreamApi = ReturnType<typeof streamApi>;
export type ActiveDraftStreamState = {
  chatId: number;
  threadId?: number;
  generation?: number;
  rawBuffer: string;
  pushChunk: (chunk: string) => void;
  closeStream: () => void;
  streamPromise: Promise<void>;
};
export type ActiveGroupStreamState = {
  chatId: string;
  threadId?: number;
  generation?: number;
  rawBuffer: string;
  messageId?: number;
  lastFlushAt: number;
};
export type ActiveProgressState = {
  chatId: string;
  threadId?: number;
  messageId?: number;
  lastText: string;
};
export type PendingUserQuestionState = {
  requestId: string;
  sourceAgentFolder: string;
  questionIndex: number;
  questionHeader: string;
  questionText: string;
  promptText: string;
  optionLabels: string[];
  multiSelect: boolean;
  selectedOptionIndexes: Set<number>;
  chatId: string;
  messageId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (selection: {
    selected: string | string[];
    answeredBy?: string;
  }) => void;
};

export function escapeTelegramMarkdownV2Plain(text: string): string {
  return text.replace(/[[\]()`>#+\-=|{}.!\\]/g, '\\$&');
}

export function escapeTelegramMarkdownV2Literal(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function escapeTelegramMarkdownV2CodeSegment(segment: string): string {
  if (segment.startsWith('```') && segment.endsWith('```')) {
    const body = segment.slice(3, -3);
    const firstNewline = body.indexOf('\n');
    if (firstNewline === -1) {
      return `\`\`\`${body.replace(/[\\`]/g, '\\$&')}\`\`\``;
    }
    const language = body.slice(0, firstNewline);
    const code = body.slice(firstNewline + 1).replace(/[\\`]/g, '\\$&');
    return `\`\`\`${language}\n${code}\`\`\``;
  }
  const code = segment.slice(1, -1).replace(/[\\`]/g, '\\$&');
  return `\`${code}\``;
}

export function escapeTelegramMarkdownV2LinkSegment(segment: string): string {
  const match = /^\[([\s\S]+)]\(([\s\S]+)\)$/.exec(segment);
  if (!match) return escapeTelegramMarkdownV2Plain(segment);
  const escapedText = escapeTelegramMarkdownV2Plain(match[1]);
  const escapedUrl = match[2].replace(/[)\\]/g, '\\$&');
  return `[${escapedText}](${escapedUrl})`;
}

/**
 * Escape text for Telegram MarkdownV2 while preserving markdown formatting
 * markers produced by parseTextStyles (bold/italic/strikethrough/links/code).
 */
export function escapeTelegramMarkdownV2(text: string): string {
  if (!text) return text;
  const protectedPattern =
    /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\((?:\\.|[^\\\n)])+\)/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = protectedPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out += escapeTelegramMarkdownV2Plain(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      out += escapeTelegramMarkdownV2CodeSegment(token);
    } else {
      out += escapeTelegramMarkdownV2LinkSegment(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    out += escapeTelegramMarkdownV2Plain(text.slice(lastIndex));
  }
  return out;
}

export function* iterTelegramTextChunks(
  text: string,
  maxCodeUnits: number,
): Generator<string> {
  if (text.length <= maxCodeUnits) {
    yield text;
    return;
  }

  let chunkStart = 0;
  let chunkLength = 0;
  for (const codePoint of text) {
    const codePointLength = codePoint.length;
    if (chunkLength > 0 && chunkLength + codePointLength > maxCodeUnits) {
      yield text.slice(chunkStart, chunkStart + chunkLength);
      chunkStart += chunkLength;
      chunkLength = 0;
    }
    chunkLength += codePointLength;
  }
  if (chunkStart < text.length) {
    yield text.slice(chunkStart);
  }
}

export function countTelegramTextChunks(
  text: string,
  maxCodeUnits: number,
): number {
  if (text.length <= maxCodeUnits) return 1;
  let count = 0;
  let chunkLength = 0;
  for (const codePoint of text) {
    const codePointLength = codePoint.length;
    if (chunkLength > 0 && chunkLength + codePointLength > maxCodeUnits) {
      count += 1;
      chunkLength = 0;
    }
    chunkLength += codePointLength;
  }
  if (chunkLength > 0) {
    count += 1;
  }
  return count;
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

export function telegramThreadOptionsFromString(threadId?: string): {
  message_thread_id?: number;
} {
  if (!threadId) return {};
  if (!/^\d+$/.test(threadId)) return {};
  const parsedThreadId = Number.parseInt(threadId, 10);
  return Number.isSafeInteger(parsedThreadId) && parsedThreadId > 0
    ? { message_thread_id: parsedThreadId }
    : {};
}

export function truncateUtf8ToByteLimit(
  text: string,
  maxBytes: number,
): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '...';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (maxBytes <= suffixBytes) return suffix.slice(0, maxBytes);
  let out = '';
  for (const char of text) {
    const next = out + char;
    if (Buffer.byteLength(next, 'utf8') + suffixBytes > maxBytes) break;
    out = next;
  }
  return `${out}${suffix}`;
}

export function stripInternalTagsPreserveWhitespace(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
}

export function formatTelegramStreamingText(
  rawText: string,
  done?: boolean,
): string {
  const text = stripInternalTagsPreserveWhitespace(rawText);
  if (!text) return '';
  return done ? parseTextStyles(text, 'telegram-html') : text;
}

/**
 * Send a message with Telegram MarkdownV2, then plain text.
 */
export async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  await sendTelegramMessageWithResult(api, chatId, text, options);
}

export async function sendTelegramMessageWithResult(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<number | undefined> {
  try {
    const sent = await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'MarkdownV2',
    });
    return (sent as { message_id?: number })?.message_id;
  } catch (errV2Raw) {
    logger.debug(
      { err: errV2Raw },
      'MarkdownV2 send failed, retrying with escaped text',
    );
  }

  try {
    const sent = await api.sendMessage(chatId, escapeTelegramMarkdownV2(text), {
      ...options,
      parse_mode: 'MarkdownV2',
    });
    return (sent as { message_id?: number })?.message_id;
  } catch (errV2Escaped) {
    logger.debug(
      { err: errV2Escaped },
      'Escaped MarkdownV2 send failed, falling back to plain text',
    );
  }

  const sent = await api.sendMessage(chatId, text, options);
  return (sent as { message_id?: number })?.message_id;
}

export async function editTelegramMessage(
  api: { editMessageText: Api['editMessageText'] },
  chatId: string | number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await api.editMessageText(chatId, messageId, text, {
      parse_mode: 'MarkdownV2',
    });
    return;
  } catch (errV2Raw) {
    const msg = errV2Raw instanceof Error ? errV2Raw.message : String(errV2Raw);
    if (/message is not modified/i.test(msg)) return;
    logger.debug(
      { err: errV2Raw },
      'MarkdownV2 edit failed, retrying with escaped text',
    );
  }

  try {
    await api.editMessageText(
      chatId,
      messageId,
      escapeTelegramMarkdownV2(text),
      {
        parse_mode: 'MarkdownV2',
      },
    );
    return;
  } catch (errV2Escaped) {
    const msg =
      errV2Escaped instanceof Error
        ? errV2Escaped.message
        : String(errV2Escaped);
    if (/message is not modified/i.test(msg)) return;
    logger.debug(
      { err: errV2Escaped },
      'Escaped MarkdownV2 edit failed, falling back to plain text',
    );
  }

  try {
    await api.editMessageText(chatId, messageId, text);
  } catch (errPlain) {
    const msg = errPlain instanceof Error ? errPlain.message : String(errPlain);
    if (/message is not modified/i.test(msg)) return;
    throw errPlain;
  }
}
