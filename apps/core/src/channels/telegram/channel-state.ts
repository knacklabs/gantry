import { Bot } from 'grammy';
import { ChannelAdapter, ChannelOpts } from '../channel-provider.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
  MessageSendOptions,
} from '../../domain/types.js';
import { AsyncTaskQueue } from '../../app/bootstrap/async-task-queue.js';
import {
  TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY,
  TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX,
  TELEGRAM_GROUP_EDIT_INTERVAL_MS,
  TELEGRAM_DRAFT_MAX_LENGTH,
  TelegramContext,
  TelegramStreamApi,
  ActiveDraftStreamState,
  ActiveGroupStreamState,
  ActiveProgressState,
  PendingUserQuestionState,
  formatTelegramStreamingText,
  sendTelegramMessageWithResult,
  editTelegramMessage,
} from './channel-shared.js';
import { logger } from '../../infrastructure/logging/logger.js';

export abstract class TelegramChannelState implements ChannelAdapter {
  name = 'telegram';

  protected bot: Bot<TelegramContext> | null = null;
  protected draftStreamApi: TelegramStreamApi | null = null;
  protected isStopping = false;
  protected pollingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  protected opts: ChannelOpts;
  protected botToken: string;
  protected pendingPermissionPrompts = new Map<
    string,
    {
      sourceGroup: string;
      chatId: string;
      messageId: number;
      timer: ReturnType<typeof setTimeout>;
      resolve: (decision: PermissionApprovalDecision) => void;
    }
  >();
  protected pendingUserQuestions = new Map<string, PendingUserQuestionState>();
  protected activeDraftStreams = new Map<string, ActiveDraftStreamState>();
  protected activeGroupStreams = new Map<string, ActiveGroupStreamState>();
  protected streamGenerationByJid = new Map<string, number>();
  protected sealedStreamGenerationByJid = new Map<string, number>();
  protected activeProgressMessages = new Map<string, ActiveProgressState>();
  protected mediaIngestionQueue = new AsyncTaskQueue(
    TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY,
    TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX,
    TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX,
  );
  protected nextDraftIdOffset = 1;

  constructor(botToken: string, opts: ChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  protected redactBotToken(input: string): string {
    if (!input) return input;
    return input.split(this.botToken).join('[REDACTED_BOT_TOKEN]');
  }

  protected sanitizeErrorMessage(err: unknown): string {
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

  protected sanitizeTelegramFilePath(rawPath: string): string | null {
    const normalized = rawPath.replace(/\\/g, '/').trim();
    if (!normalized) return null;
    if (normalized.startsWith('/') || normalized.includes('..')) return null;
    if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) return null;
    return normalized;
  }

  protected clearPollingRetryTimer(): void {
    if (!this.pollingRetryTimer) return;
    clearTimeout(this.pollingRetryTimer);
    this.pollingRetryTimer = null;
  }

  protected buildDraftStreamKey(jid: string, threadId?: string): string {
    return `${jid}:${threadId || ''}`;
  }

  protected clearStreamingStateForJid(jid: string): void {
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

  protected shouldAcceptStreamingChunk(
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

  protected isCurrentStreamingGeneration(
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

  protected markStreamingGenerationDone(
    jid: string,
    generation?: number,
  ): void {
    if (generation === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || generation > sealed) {
      this.sealedStreamGenerationByJid.set(jid, generation);
    }
  }

  protected sealStreamingGenerationOnReset(jid: string): void {
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || latest > sealed) {
      this.sealedStreamGenerationByJid.set(jid, latest);
    }
  }

  protected isLikelyPrivateChatId(numericId: string): boolean {
    return !numericId.startsWith('-');
  }

  protected createDraftChunkStream(): {
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

  protected async handleGroupStreamingChunk(
    jid: string,
    numericId: string,
    text: string,
    options: StreamingChunkOptions,
  ): Promise<boolean> {
    if (!this.bot) return false;
    let delivered = false;
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
      return false;
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
            if (messageId) {
              state.messageId = messageId;
              delivered = true;
            }
          } else {
            const sent = await this.bot.api.sendMessage(
              numericId,
              headText,
              sendOptions,
            );
            const messageId = (sent as { message_id?: number })?.message_id;
            if (messageId) {
              state.messageId = messageId;
              delivered = true;
            }
          }
        } else if (options.done) {
          // Final edit — apply MarkdownV2 formatting
          await editTelegramMessage(
            this.bot.api,
            numericId,
            state.messageId,
            headText,
          );
          delivered = true;
        } else {
          // Intermediate edits — plain text, single API call, no fallback cascade
          try {
            await this.bot.api.editMessageText(
              numericId,
              state.messageId,
              headText,
            );
            delivered = true;
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
            delivered = true;
          }
          this.markStreamingGenerationDone(jid, options.generation);
        }
        return delivered || Boolean(state.messageId);
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
          delivered = true;
        }
        this.activeGroupStreams.delete(key);
        this.markStreamingGenerationDone(jid, options.generation);
      }
      return delivered || Boolean(state.messageId);
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
        delivered = true;
      }
      this.markStreamingGenerationDone(jid, options.generation);
    }
    return delivered || Boolean(state.messageId);
  }

  protected schedulePollingRetry(): void {
    if (this.isStopping || !this.bot || this.pollingRetryTimer) return;
    const retryDelayMs = 3000;
    logger.warn({ retryDelayMs }, 'Retrying Telegram polling');
    this.pollingRetryTimer = setTimeout(() => {
      this.pollingRetryTimer = null;
      this.startPolling();
    }, retryDelayMs);
  }

  protected abstract startPolling(): void;
  abstract connect(): Promise<void>;
  abstract sendMessage(
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ): Promise<{ externalMessageId?: string }>;
  abstract sendStreamingChunk(
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ): Promise<boolean>;
  abstract sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
  abstract requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision>;
  abstract requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse>;
  abstract isConnected(): boolean;
  abstract ownsJid(jid: string): boolean;
  abstract resetStreaming(jid: string): void;
  abstract disconnect(): Promise<void>;
  abstract setTyping(jid: string, isTyping: boolean): Promise<void>;
}
