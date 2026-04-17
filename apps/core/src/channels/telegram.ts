import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { StreamFlavor, stream, streamApi } from '@grammyjs/stream';

import {
  ASSISTANT_NAME,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  TELEGRAM_PERMISSION_APPROVER_IDS,
  TRIGGER_PATTERN,
} from '../core/config.js';
import { readEnvFile } from '../core/env.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { logger } from '../core/logger.js';
import { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../core/types.js';
import { parseTextStyles } from '../text-styles.js';

const TELEGRAM_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const TELEGRAM_DRAFT_MAX_LENGTH = 4096;
const TELEGRAM_STREAM_CHUNK_MAX_LENGTH = 3500;
const TELEGRAM_GROUP_EDIT_INTERVAL_MS = 900;
const TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES = 56;
// Keep question timeout aligned with permission approvals for now.
// This can be split into a separate config knob later if UX needs diverge.
const TELEGRAM_USER_QUESTION_TIMEOUT_MS = PERMISSION_APPROVAL_TIMEOUT_MS;
const TELEGRAM_PERMISSION_CALLBACK_PATTERN =
  /^perm:(approve|deny):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/;
const TELEGRAM_USER_QUESTION_CALLBACK_PATTERN =
  /^userq:(select|done):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127}):(\d+)(?::(\d+))?$/;

type TelegramContext = StreamFlavor<Context>;
type TelegramStreamApi = ReturnType<typeof streamApi>;
type ActiveDraftStreamState = {
  chatId: number;
  threadId?: number;
  generation?: number;
  rawBuffer: string;
  pushChunk: (chunk: string) => void;
  closeStream: () => void;
  streamPromise: Promise<void>;
};
type ActiveGroupStreamState = {
  chatId: string;
  threadId?: number;
  generation?: number;
  rawBuffer: string;
  messageId?: number;
  lastFlushAt: number;
};
type ActiveProgressState = {
  chatId: string;
  threadId?: number;
  messageId?: number;
  lastText: string;
};
type PendingUserQuestionState = {
  requestId: string;
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

export interface TelegramChannelOpts extends ChannelOpts {}

function escapeTelegramMarkdownV2Plain(text: string): string {
  return text.replace(/[\[\]()`>#+\-=|{}.!\\]/g, '\\$&');
}

function escapeTelegramMarkdownV2Literal(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function escapeTelegramMarkdownV2CodeSegment(segment: string): string {
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

function escapeTelegramMarkdownV2LinkSegment(segment: string): string {
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
function escapeTelegramMarkdownV2(text: string): string {
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

function splitTelegramDraftChunks(text: string): string[] {
  if (text.length <= TELEGRAM_STREAM_CHUNK_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_STREAM_CHUNK_MAX_LENGTH) {
    chunks.push(text.slice(i, i + TELEGRAM_STREAM_CHUNK_MAX_LENGTH));
  }
  return chunks;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function truncateUtf8ToByteLimit(text: string, maxBytes: number): string {
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

function stripInternalTagsPreserveWhitespace(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
}

function formatTelegramStreamingText(rawText: string, done?: boolean): string {
  const text = stripInternalTagsPreserveWhitespace(rawText);
  if (!text) return '';
  return done ? parseTextStyles(text, 'telegram') : text;
}

/**
 * Send a message with Telegram MarkdownV2, then plain text.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  await sendTelegramMessageWithResult(api, chatId, text, options);
}

async function sendTelegramMessageWithResult(
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

async function editTelegramMessage(
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

export class TelegramChannel implements ChannelAdapter {
  name = 'telegram';

  private bot: Bot<TelegramContext> | null = null;
  private draftStreamApi: TelegramStreamApi | null = null;
  private isStopping = false;
  private pollingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private pendingPermissionPrompts = new Map<
    string,
    {
      chatId: string;
      messageId: number;
      timer: ReturnType<typeof setTimeout>;
      resolve: (decision: PermissionApprovalDecision) => void;
    }
  >();
  private pendingUserQuestions = new Map<string, PendingUserQuestionState>();
  private activeDraftStreams = new Map<string, ActiveDraftStreamState>();
  private activeGroupStreams = new Map<string, ActiveGroupStreamState>();
  private streamGenerationByJid = new Map<string, number>();
  private sealedStreamGenerationByJid = new Map<string, number>();
  private activeProgressMessages = new Map<string, ActiveProgressState>();
  private nextDraftIdOffset = 1;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private redactBotToken(input: string): string {
    if (!input) return input;
    return input.split(this.botToken).join('[REDACTED_BOT_TOKEN]');
  }

  private sanitizeErrorMessage(err: unknown): string {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof (err as { message?: unknown }).message === 'string'
          ? ((err as { message: string }).message ?? '')
          : String(err);
    return this.redactBotToken(message);
  }

  private async writeFetchResponseToFile(
    response: {
      body?: {
        getReader?: () => {
          read: () => Promise<{ done: boolean; value?: Uint8Array }>;
        };
      } | null;
      arrayBuffer?: () => Promise<ArrayBuffer>;
      headers?: { get: (name: string) => string | null };
    },
    destPath: string,
  ): Promise<boolean> {
    const declaredLength = Number(response.headers?.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > TELEGRAM_MAX_DOWNLOAD_BYTES
    ) {
      logger.warn(
        {
          declaredLength,
          maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
        },
        'Telegram file exceeds max allowed size',
      );
      return false;
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      if (!response.arrayBuffer) {
        throw new Error('Telegram download response body is missing');
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > TELEGRAM_MAX_DOWNLOAD_BYTES) {
        logger.warn(
          {
            bytes: buffer.byteLength,
            maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
          },
          'Telegram file exceeds max allowed size',
        );
        return false;
      }
      fs.writeFileSync(destPath, buffer);
      return true;
    }

    const fd = fs.openSync(destPath, 'w');
    let totalBytes = 0;
    let shouldCleanup = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        if (!value || value.byteLength === 0) continue;
        totalBytes += value.byteLength;
        if (totalBytes > TELEGRAM_MAX_DOWNLOAD_BYTES) {
          shouldCleanup = true;
          logger.warn(
            {
              bytes: totalBytes,
              maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
            },
            'Telegram file exceeds max allowed size',
          );
          return false;
        }
        fs.writeSync(fd, Buffer.from(value));
      }
      return true;
    } catch (err) {
      shouldCleanup = true;
      throw err;
    } finally {
      fs.closeSync(fd);
      if (shouldCleanup) {
        try {
          fs.unlinkSync(destPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  private sanitizeTelegramFilePath(rawPath: string): string | null {
    const normalized = rawPath.replace(/\\/g, '/').trim();
    if (!normalized) return null;
    if (normalized.startsWith('/') || normalized.includes('..')) return null;
    if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) return null;
    return normalized;
  }

  private clearPollingRetryTimer(): void {
    if (!this.pollingRetryTimer) return;
    clearTimeout(this.pollingRetryTimer);
    this.pollingRetryTimer = null;
  }

  private buildDraftStreamKey(jid: string, threadId?: string): string {
    return `${jid}:${threadId || ''}`;
  }

  private clearStreamingStateForJid(jid: string): void {
    for (const [key, state] of this.activeDraftStreams.entries()) {
      if (!key.startsWith(`${jid}:`)) continue;
      state.closeStream();
      this.activeDraftStreams.delete(key);
    }
    for (const key of this.activeGroupStreams.keys()) {
      if (!key.startsWith(`${jid}:`)) continue;
      this.activeGroupStreams.delete(key);
    }
  }

  private shouldAcceptStreamingChunk(
    jid: string,
    generation?: number,
  ): boolean {
    if (generation === undefined) return true;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed !== undefined && generation <= sealed) {
      return false;
    }

    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) {
      this.streamGenerationByJid.set(jid, generation);
      return true;
    }
    if (generation < latest) {
      return false;
    }
    if (generation > latest) {
      this.clearStreamingStateForJid(jid);
      this.streamGenerationByJid.set(jid, generation);
    }
    return true;
  }

  private isCurrentStreamingGeneration(
    jid: string,
    generation?: number,
  ): boolean {
    if (generation === undefined) return true;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed !== undefined && generation <= sealed) {
      return false;
    }
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) return true;
    return generation === latest;
  }

  private markStreamingGenerationDone(jid: string, generation?: number): void {
    if (generation === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || generation > sealed) {
      this.sealedStreamGenerationByJid.set(jid, generation);
    }
  }

  private sealStreamingGenerationOnReset(jid: string): void {
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || latest > sealed) {
      this.sealedStreamGenerationByJid.set(jid, latest);
    }
  }

  private isLikelyPrivateChatId(numericId: string): boolean {
    return !numericId.startsWith('-');
  }

  private createDraftChunkStream(): {
    iterator: AsyncIterable<string>;
    push: (chunk: string) => void;
    close: () => void;
  } {
    const chunks: string[] = [];
    let closed = false;
    let resolver: (() => void) | null = null;
    const wake = () => {
      if (resolver) {
        const resolve = resolver;
        resolver = null;
        resolve();
      }
    };
    return {
      iterator: (async function* () {
        while (!closed || chunks.length > 0) {
          if (chunks.length === 0) {
            await new Promise<void>((resolve) => {
              resolver = resolve;
            });
            continue;
          }
          const next = chunks.shift();
          if (next) yield next;
        }
      })(),
      push: (chunk: string) => {
        if (!chunk) return;
        chunks.push(chunk);
        wake();
      },
      close: () => {
        closed = true;
        wake();
      },
    };
  }

  private async handleGroupStreamingChunk(
    jid: string,
    numericId: string,
    text: string,
    options: StreamingChunkOptions,
  ): Promise<void> {
    if (!this.bot) return;
    const parsedThreadId = options.threadId
      ? Number.parseInt(options.threadId, 10)
      : undefined;
    const key = this.buildDraftStreamKey(jid, options.threadId);
    let state = this.activeGroupStreams.get(key);
    if (!state) {
      state = {
        chatId: numericId,
        threadId: Number.isFinite(parsedThreadId) ? parsedThreadId : undefined,
        generation: options.generation,
        rawBuffer: '',
        lastFlushAt: 0,
      };
      this.activeGroupStreams.set(key, state);
    }

    if (text) state.rawBuffer += text;
    const renderedBuffer = formatTelegramStreamingText(
      state.rawBuffer,
      options.done,
    );
    const hasContent = renderedBuffer.trim().length > 0;
    if (!hasContent) {
      if (options.done) {
        this.activeGroupStreams.delete(key);
        this.markStreamingGenerationDone(jid, options.generation);
      }
      return;
    }

    const now = Date.now();
    const shouldFlush =
      options.done ||
      !state.messageId ||
      now - state.lastFlushAt >= TELEGRAM_GROUP_EDIT_INTERVAL_MS;

    try {
      if (shouldFlush) {
        const headText = renderedBuffer.slice(0, TELEGRAM_DRAFT_MAX_LENGTH);
        if (!state.messageId) {
          // First message — send as plain text during streaming, formatted on done
          const sendOptions = state.threadId
            ? { message_thread_id: state.threadId }
            : {};
          if (options.done) {
            const messageId = await sendTelegramMessageWithResult(
              this.bot.api,
              numericId,
              headText,
              sendOptions,
            );
            if (messageId) state.messageId = messageId;
          } else {
            const sent = await this.bot.api.sendMessage(
              numericId,
              headText,
              sendOptions,
            );
            const messageId = (sent as { message_id?: number })?.message_id;
            if (messageId) state.messageId = messageId;
          }
        } else if (options.done) {
          // Final edit — apply MarkdownV2 formatting
          await editTelegramMessage(
            this.bot.api,
            numericId,
            state.messageId,
            headText,
          );
        } else {
          // Intermediate edits — plain text, single API call, no fallback cascade
          try {
            await this.bot.api.editMessageText(
              numericId,
              state.messageId,
              headText,
            );
          } catch (err) {
            const msg = this.sanitizeErrorMessage(err);
            if (!/message is not modified/i.test(msg)) {
              logger.debug({ err: msg }, 'Streaming plain-text edit failed');
            }
          }
        }
        state.lastFlushAt = now;
      }
    } catch (err) {
      const sanitizedError = this.sanitizeErrorMessage(err);
      const isNotModified = /message is not modified/i.test(sanitizedError);
      if (isNotModified) {
        logger.debug(
          { jid, err: sanitizedError },
          'Telegram group stream update had no text changes',
        );
        if (options.done) {
          this.activeGroupStreams.delete(key);
          const overflowText = renderedBuffer
            .slice(TELEGRAM_DRAFT_MAX_LENGTH)
            .trim();
          if (
            overflowText &&
            this.isCurrentStreamingGeneration(jid, options.generation)
          ) {
            await this.sendMessage(jid, overflowText, {
              threadId: options.threadId,
            });
          }
          this.markStreamingGenerationDone(jid, options.generation);
        }
        return;
      }
      logger.warn(
        { jid, err: sanitizedError },
        'Telegram group stream update failed',
      );
      if (options.done) {
        if (this.isCurrentStreamingGeneration(jid, options.generation)) {
          await this.sendMessage(jid, renderedBuffer, {
            threadId: options.threadId,
          });
        }
        this.activeGroupStreams.delete(key);
        this.markStreamingGenerationDone(jid, options.generation);
      }
      return;
    }

    if (options.done) {
      this.activeGroupStreams.delete(key);
      const overflowText = renderedBuffer
        .slice(TELEGRAM_DRAFT_MAX_LENGTH)
        .trim();
      if (
        overflowText &&
        this.isCurrentStreamingGeneration(jid, options.generation)
      ) {
        await this.sendMessage(jid, overflowText, {
          threadId: options.threadId,
        });
      }
      this.markStreamingGenerationDone(jid, options.generation);
    }
  }

  private schedulePollingRetry(): void {
    if (this.isStopping || !this.bot || this.pollingRetryTimer) return;
    const retryDelayMs = 3000;
    logger.warn({ retryDelayMs }, 'Retrying Telegram polling');
    this.pollingRetryTimer = setTimeout(() => {
      this.pollingRetryTimer = null;
      this.startPolling();
    }, retryDelayMs);
  }

  private formatPermissionPromptText(
    request: PermissionApprovalRequest,
    timeoutMs: number,
  ): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    const lines = [
      `Permission request: ${request.requestId}`,
      `Tool: ${request.displayName || request.toolName}`,
      `Source: ${request.sourceGroup}`,
    ];
    if (request.title) lines.push(`Action: ${request.title}`);
    if (request.blockedPath) lines.push(`Path: ${request.blockedPath}`);
    if (request.decisionReason) lines.push(`Reason: ${request.decisionReason}`);
    if (request.description) lines.push(`Details: ${request.description}`);
    lines.push(...this.formatPermissionToolInputLines(request));
    lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
    return lines.join('\n');
  }

  private formatPermissionToolInputLines(
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

  private pendingUserQuestionKey(
    requestId: string,
    questionIndex: number,
  ): string {
    return `${requestId}:${questionIndex}`;
  }

  private formatUserQuestionPromptText(
    question: UserQuestionRequest['questions'][number],
    timeoutMs: number,
  ): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    const lines = [`❓ ${question.header}`, question.question, ''];
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

  private formatUserQuestionButtonLabel(
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

  private buildUserQuestionKeyboard(
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

  private async isTelegramApproverAuthorized(
    chatId: string,
    userId: string,
  ): Promise<boolean> {
    if (TELEGRAM_PERMISSION_APPROVER_IDS.has(userId)) return true;
    if (!this.bot) return false;
    const userNumericId = parseInt(userId, 10);
    if (!Number.isFinite(userNumericId)) return false;
    try {
      const member = await this.bot.api.getChatMember(chatId, userNumericId);
      const status =
        typeof member === 'object' && member !== null && 'status' in member
          ? String((member as { status?: unknown }).status)
          : '';
      return status === 'creator' || status === 'administrator';
    } catch (err) {
      logger.warn(
        { chatId, userId, err: this.sanitizeErrorMessage(err) },
        'Failed to verify Telegram approver role',
      );
      return false;
    }
  }

  private async resolvePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingPermissionPrompts.get(requestId);
    if (!pending || !this.bot) return;
    this.pendingPermissionPrompts.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);

    const status = decision.approved ? 'APPROVED' : 'DENIED';
    const actor = decision.decidedBy || 'unknown';
    const reasonSuffix = decision.reason ? ` (${decision.reason})` : '';
    const text = `Permission request ${requestId}\nStatus: ${status} by ${actor}${reasonSuffix}`;
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

  private async refreshUserQuestionPrompt(
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

  private async finalizeUserQuestionPrompt(
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

  private startPolling(): void {
    if (!this.bot || this.isStopping) return;

    Promise.resolve(
      this.bot.start({
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
      }),
    )
      .then(() => {
        if (this.isStopping) return;
        logger.warn('Telegram polling stopped unexpectedly');
        this.schedulePollingRetry();
      })
      .catch((err) => {
        if (this.isStopping) return;
        logger.error({ err }, 'Telegram polling failed');
        this.schedulePollingRetry();
      });
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the agent workspace path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
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
      fs.mkdirSync(attachDir, { recursive: true });

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

      const wrote = await this.writeFetchResponseToFile(resp, destPath);
      if (!wrote) return null;

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error(
        { fileId, error: this.sanitizeErrorMessage(err) },
        'Failed to download Telegram file',
      );
      return null;
    }
  }

  async connect(): Promise<void> {
    this.isStopping = false;
    this.clearPollingRetryTimer();
    this.bot = new Bot<TelegramContext>(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });
    this.bot.api.config.use(autoRetry());
    this.bot.use(stream());
    this.draftStreamApi = streamApi(this.bot.api.raw);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${escapeTelegramMarkdownV2Literal(String(chatId))}\`\nName: ${escapeTelegramMarkdownV2Literal(chatName)}\nType: ${escapeTelegramMarkdownV2Literal(chatType)}`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('callback_query:data', async (ctx: any) => {
      const data =
        typeof ctx.callbackQuery?.data === 'string'
          ? ctx.callbackQuery.data
          : '';
      const userQuestionMatch =
        TELEGRAM_USER_QUESTION_CALLBACK_PATTERN.exec(data);
      if (userQuestionMatch) {
        const action = userQuestionMatch[1] as 'select' | 'done';
        const requestId = userQuestionMatch[2];
        const questionIndex = Number.parseInt(userQuestionMatch[3], 10);
        const optionIndex = userQuestionMatch[4]
          ? Number.parseInt(userQuestionMatch[4], 10)
          : undefined;
        const key = this.pendingUserQuestionKey(requestId, questionIndex);
        const pending = this.pendingUserQuestions.get(key);
        if (!pending) {
          await ctx.answerCallbackQuery({
            text: 'Question is no longer active.',
            show_alert: true,
          });
          return;
        }
        const callbackChatId = ctx.chat?.id?.toString() || '';
        if (!callbackChatId || callbackChatId !== pending.chatId) {
          await ctx.answerCallbackQuery({
            text: 'This question belongs to a different chat.',
            show_alert: true,
          });
          return;
        }
        const answeredBy =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'unknown';
        if (action === 'done') {
          if (!pending.multiSelect) {
            await ctx.answerCallbackQuery({
              text: 'This question expects a single selection.',
              show_alert: true,
            });
            return;
          }
          const selectedLabels = [...pending.selectedOptionIndexes]
            .sort((a, b) => a - b)
            .map((index) => pending.optionLabels[index])
            .filter(Boolean);
          await this.finalizeUserQuestionPrompt(
            pending,
            selectedLabels,
            answeredBy,
            'answered via Telegram',
          );
          await ctx.answerCallbackQuery({
            text: 'Saved.',
          });
          return;
        }

        if (
          optionIndex === undefined ||
          !Number.isInteger(optionIndex) ||
          optionIndex < 0 ||
          optionIndex >= pending.optionLabels.length
        ) {
          await ctx.answerCallbackQuery({
            text: 'Invalid option.',
            show_alert: true,
          });
          return;
        }

        if (pending.multiSelect) {
          if (pending.selectedOptionIndexes.has(optionIndex)) {
            pending.selectedOptionIndexes.delete(optionIndex);
          } else {
            pending.selectedOptionIndexes.add(optionIndex);
          }
          await this.refreshUserQuestionPrompt(pending);
          await ctx.answerCallbackQuery({
            text: 'Selection updated.',
          });
          return;
        }

        const selected = pending.optionLabels[optionIndex];
        await this.finalizeUserQuestionPrompt(
          pending,
          selected,
          answeredBy,
          'answered via Telegram',
        );
        await ctx.answerCallbackQuery({
          text: 'Saved.',
        });
        return;
      }

      const permissionMatch = TELEGRAM_PERMISSION_CALLBACK_PATTERN.exec(data);
      if (!permissionMatch) return;
      const action = permissionMatch[1] as 'approve' | 'deny';
      const requestId = permissionMatch[2];
      const pending = this.pendingPermissionPrompts.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery({
          text: 'Permission request is no longer active.',
          show_alert: true,
        });
        return;
      }

      const callbackChatId = ctx.chat?.id?.toString() || '';
      if (!callbackChatId || callbackChatId !== pending.chatId) {
        await ctx.answerCallbackQuery({
          text: 'This approval request belongs to a different chat.',
          show_alert: true,
        });
        return;
      }

      const userId = ctx.from?.id?.toString() || '';
      if (!userId) {
        await ctx.answerCallbackQuery({
          text: 'Unable to verify approver identity.',
          show_alert: true,
        });
        return;
      }
      const authorized = await this.isTelegramApproverAuthorized(
        pending.chatId,
        userId,
      );
      if (!authorized) {
        await ctx.answerCallbackQuery({
          text: 'Only approved admins can make this decision.',
          show_alert: true,
        });
        return;
      }

      const decidedBy =
        ctx.from?.first_name || ctx.from?.username || userId || 'unknown';
      await this.resolvePermissionPrompt(requestId, {
        approved: action === 'approve',
        decidedBy,
        reason:
          action === 'approve'
            ? 'approved via Telegram'
            : 'denied via Telegram',
      });
      await ctx.answerCallbackQuery({
        text: action === 'approve' ? 'Approved.' : 'Denied.',
      });
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error(
        { error: this.sanitizeErrorMessage(err) },
        'Telegram bot error',
      );
    });

    this.startPolling();
  }

  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const sendOptions = options.threadId
        ? { message_thread_id: parseInt(options.threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, sendOptions);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            sendOptions,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId: options.threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error(
        { jid, error: this.sanitizeErrorMessage(err) },
        'Failed to send Telegram message',
      );
    }
  }

  async sendStreamingChunk(
    jid: string,
    text: string,
    options: StreamingChunkOptions = {},
  ): Promise<void> {
    if (!this.bot || !this.draftStreamApi) return;
    if (!this.shouldAcceptStreamingChunk(jid, options.generation)) return;

    const numericId = jid.replace(/^tg:/, '');
    const parsedChatId = Number.parseInt(numericId, 10);
    if (!Number.isFinite(parsedChatId)) {
      logger.warn({ jid }, 'Invalid Telegram chat id for streaming chunk');
      return;
    }
    if (!this.isLikelyPrivateChatId(numericId)) {
      await this.handleGroupStreamingChunk(jid, numericId, text, options);
      return;
    }

    const parsedThreadId = options.threadId
      ? Number.parseInt(options.threadId, 10)
      : undefined;
    const key = this.buildDraftStreamKey(jid, options.threadId);
    let state = this.activeDraftStreams.get(key);
    if (!state && !text && options.done) {
      this.markStreamingGenerationDone(jid, options.generation);
      return;
    }
    if (!state) {
      const draftThreadId = Number.isFinite(parsedThreadId)
        ? parsedThreadId
        : undefined;
      const draftOptions = draftThreadId
        ? {
            message_thread_id: draftThreadId,
            parse_mode: 'MarkdownV2' as const,
          }
        : { parse_mode: 'MarkdownV2' as const };
      const queue = this.createDraftChunkStream();
      const draftIdOffset = this.nextDraftIdOffset * 256;
      this.nextDraftIdOffset += 1;
      const streamState: ActiveDraftStreamState = {
        chatId: parsedChatId,
        threadId: draftThreadId,
        generation: options.generation,
        rawBuffer: '',
        pushChunk: queue.push,
        closeStream: queue.close,
        streamPromise: Promise.resolve(),
      };
      const createdState = streamState;
      streamState.streamPromise = this.draftStreamApi
        .streamMessage(
          parsedChatId,
          draftIdOffset,
          queue.iterator,
          draftOptions,
          draftOptions,
        )
        .then(() => undefined)
        .catch(async (err) => {
          logger.warn(
            { jid, err: this.sanitizeErrorMessage(err) },
            'Telegram stream send failed; falling back to final message send',
          );
          const fallbackText = streamState.rawBuffer.trim();
          if (
            fallbackText &&
            this.isCurrentStreamingGeneration(jid, streamState.generation)
          ) {
            await this.sendMessage(jid, fallbackText, {
              threadId: options.threadId,
            });
          }
        })
        .finally(() => {
          const current = this.activeDraftStreams.get(key);
          if (current === createdState) {
            this.activeDraftStreams.delete(key);
          }
        });
      this.activeDraftStreams.set(key, streamState);
      state = streamState;
    }
    if (!state) return;

    if (text) {
      state.rawBuffer += text;
      const escaped = escapeTelegramMarkdownV2(text);
      for (const chunk of splitTelegramDraftChunks(escaped)) {
        if (chunk.length > TELEGRAM_DRAFT_MAX_LENGTH) {
          logger.warn(
            { jid, length: chunk.length },
            'Skipping oversize Telegram stream chunk',
          );
          continue;
        }
        state.pushChunk(chunk);
      }
    }

    if (options.done) {
      state.closeStream();
      await state.streamPromise;
      this.markStreamingGenerationDone(jid, options.generation);
    }
  }

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    const parsedThreadId = options.threadId
      ? Number.parseInt(options.threadId, 10)
      : undefined;
    const key = `progress:${this.buildDraftStreamKey(jid, options.threadId)}`;
    const nextText = text.trim();
    if (!nextText) {
      if (options.done) this.activeProgressMessages.delete(key);
      return;
    }

    const sendOptions = Number.isFinite(parsedThreadId)
      ? { message_thread_id: parsedThreadId }
      : {};
    const existing = this.activeProgressMessages.get(key);
    if (!existing) {
      const messageId = await sendTelegramMessageWithResult(
        this.bot.api,
        numericId,
        nextText,
        sendOptions,
      );
      if (!options.done) {
        this.activeProgressMessages.set(key, {
          chatId: numericId,
          threadId: Number.isFinite(parsedThreadId)
            ? parsedThreadId
            : undefined,
          messageId,
          lastText: nextText,
        });
      }
      return;
    }

    if (existing.lastText === nextText) {
      if (options.done) this.activeProgressMessages.delete(key);
      return;
    }

    if (existing.messageId) {
      try {
        await editTelegramMessage(
          this.bot.api,
          numericId,
          existing.messageId,
          nextText,
        );
      } catch (err) {
        logger.debug(
          { jid, err },
          'Failed to edit progress message, creating a fresh one',
        );
        existing.messageId = await sendTelegramMessageWithResult(
          this.bot.api,
          numericId,
          nextText,
          sendOptions,
        );
      }
    } else {
      existing.messageId = await sendTelegramMessageWithResult(
        this.bot.api,
        numericId,
        nextText,
        sendOptions,
      );
    }
    existing.lastText = nextText;
    if (options.done) {
      this.activeProgressMessages.delete(key);
    } else {
      this.activeProgressMessages.set(key, existing);
    }
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    if (!this.bot) {
      return { approved: false, reason: 'Telegram bot is not connected' };
    }
    const chatId = jid.replace(/^tg:/, '');
    if (!chatId) {
      return { approved: false, reason: 'Invalid Telegram chat ID' };
    }
    if (this.pendingPermissionPrompts.has(request.requestId)) {
      return {
        approved: false,
        reason: `Duplicate pending request: ${request.requestId}`,
      };
    }

    const timeoutMs = TELEGRAM_USER_QUESTION_TIMEOUT_MS;
    const promptText = this.formatPermissionPromptText(request, timeoutMs);
    try {
      const sent = await this.bot.api.sendMessage(chatId, promptText, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Approve',
                callback_data: `perm:approve:${request.requestId}`,
              },
              { text: 'Deny', callback_data: `perm:deny:${request.requestId}` },
            ],
          ],
        },
      });
      return await new Promise<PermissionApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          void this.resolvePermissionPrompt(request.requestId, {
            approved: false,
            decidedBy: 'system',
            reason: 'timed out',
          });
        }, timeoutMs);
        this.pendingPermissionPrompts.set(request.requestId, {
          chatId,
          messageId: sent.message_id,
          timer,
          resolve,
        });
      });
    } catch (err) {
      logger.error(
        {
          jid,
          requestId: request.requestId,
          error: this.sanitizeErrorMessage(err),
        },
        'Failed to send Telegram permission prompt',
      );
      return {
        approved: false,
        reason: 'Failed to send approval prompt to Telegram',
      };
    }
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    if (!this.bot) {
      return { requestId: request.requestId, answers: {} };
    }
    const chatId = jid.replace(/^tg:/, '');
    if (!chatId) {
      return { requestId: request.requestId, answers: {} };
    }

    const timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS;
    const answers: Record<string, string | string[]> = {};
    let answeredBy: string | undefined;

    for (let i = 0; i < request.questions.length; i += 1) {
      const question = request.questions[i];
      const pendingKey = this.pendingUserQuestionKey(request.requestId, i);
      if (this.pendingUserQuestions.has(pendingKey)) {
        logger.warn(
          { requestId: request.requestId, questionIndex: i },
          'Duplicate pending user question request detected',
        );
        continue;
      }

      const promptText = this.formatUserQuestionPromptText(question, timeoutMs);
      try {
        const sent = await this.bot.api.sendMessage(chatId, promptText, {
          reply_markup: this.buildUserQuestionKeyboard(
            request.requestId,
            i,
            question,
            new Set<number>(),
          ),
        });

        const selection = await new Promise<{
          selected: string | string[];
          answeredBy?: string;
        }>((resolve) => {
          const timer = setTimeout(() => {
            const timedOut = this.pendingUserQuestions.get(pendingKey);
            if (!timedOut) return;
            // Fire-and-forget is intentional: timer callback should never block
            // the event loop while we cleanup stale pending prompts.
            void this.finalizeUserQuestionPrompt(
              timedOut,
              timedOut.multiSelect ? [] : '',
              'system',
              'timed out',
            );
          }, timeoutMs);

          this.pendingUserQuestions.set(pendingKey, {
            requestId: request.requestId,
            questionIndex: i,
            questionHeader: question.header,
            questionText: question.question,
            promptText,
            optionLabels: question.options.map((option) => option.label),
            multiSelect: question.multiSelect,
            selectedOptionIndexes: new Set<number>(),
            chatId,
            messageId: sent.message_id,
            timer,
            resolve,
          });
        });

        const isEmptySelection = Array.isArray(selection.selected)
          ? selection.selected.length === 0
          : selection.selected.trim().length === 0;
        if (isEmptySelection) {
          // Timeout or explicit empty submission: omit this answer so the SDK
          // receives an empty answer map and treats it as unanswered/declined.
          continue;
        }

        if (selection.answeredBy) answeredBy = selection.answeredBy;
        if (Array.isArray(selection.selected)) {
          answers[question.question] = selection.selected;
        } else {
          answers[question.question] = selection.selected;
        }
      } catch (err) {
        logger.warn(
          {
            requestId: request.requestId,
            questionIndex: i,
            err: this.sanitizeErrorMessage(err),
          },
          'Failed to run Telegram user question prompt',
        );
      }
    }

    return {
      requestId: request.requestId,
      answers,
      ...(answeredBy ? { answeredBy } : {}),
    };
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  resetStreaming(jid: string): void {
    this.sealStreamingGenerationOnReset(jid);
    this.clearStreamingStateForJid(jid);
  }

  async disconnect(): Promise<void> {
    this.isStopping = true;
    this.clearPollingRetryTimer();
    for (const streamState of this.activeDraftStreams.values()) {
      streamState.closeStream();
    }
    this.activeDraftStreams.clear();
    this.activeGroupStreams.clear();
    this.streamGenerationByJid.clear();
    this.sealedStreamGenerationByJid.clear();
    this.activeProgressMessages.clear();
    for (const [
      requestId,
      pending,
    ] of this.pendingPermissionPrompts.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        approved: false,
        decidedBy: 'system',
        reason: 'Telegram channel disconnected',
      });
      this.pendingPermissionPrompts.delete(requestId);
    }
    for (const [key, pending] of this.pendingUserQuestions.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        selected: pending.multiSelect ? [] : '',
        answeredBy: 'system',
      });
      this.pendingUserQuestions.delete(key);
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      this.draftStreamApi = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

export function createTelegramChannel(
  opts: ChannelOpts,
): TelegramChannel | null {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
}
