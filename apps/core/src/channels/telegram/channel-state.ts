import { createHash } from 'crypto';

import { Bot } from 'grammy';
import { ChannelAdapter, ChannelOpts } from '../channel-provider.js';
import type { RuntimeLease } from '../../domain/ports/runtime-lease.js';
import {
  MessageDeliveryResult,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
  MessageSendOptions,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { AsyncTaskQueue } from '../../app/bootstrap/async-task-queue.js';
import {
  TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY,
  TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX,
  TELEGRAM_GROUP_EDIT_INTERVAL_MS,
  TelegramContext,
  TelegramStreamApi,
  ActiveDraftStreamState,
  ActiveGroupStreamState,
  ActiveProgressState,
  PendingUserQuestionState,
  formatTelegramStreamingText,
  sendTelegramMessageWithResult,
  editTelegramMessage,
  splitTelegramDeliveryText,
} from './channel-shared.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  channelProgressStateFilePath,
  readProgressStateEntries,
  writeProgressStateEntries,
} from '../progress-state-file.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

export abstract class TelegramChannelState implements ChannelAdapter {
  name = 'telegram';

  protected bot: Bot<TelegramContext> | null = null;
  protected draftStreamApi: TelegramStreamApi | null = null;
  protected isStopping = false;
  protected pollingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  protected pollingLease: RuntimeLease | null = null;
  protected pollingStartInFlight = false;
  protected interactionCallbacksEnabled = true;
  protected opts: ChannelOpts;
  protected botToken: string;
  protected pendingPermissionPrompts = new Map<
    string,
    {
      callbackId: string;
      sourceAgentFolder: string;
      decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
      approvalContextJid?: string;
      request: PermissionApprovalRequest;
      chatId: string;
      messageId: number;
      timer: ReturnType<typeof setTimeout>;
      resolve: (decision: PermissionApprovalDecision) => void;
    }
  >();
  protected pendingPermissionCallbackIds = new Map<string, string>();
  private permissionCallbackCounter = 0;
  protected pendingUserQuestions = new Map<string, PendingUserQuestionState>();
  // Maps a ForceReply prompt (the "Other" free-text path) back to its question.
  // Keyed by `${chatId}:${forceReplyMessageId}`.
  protected pendingUserQuestionOtherPrompts = new Map<
    string,
    { requestId: string; questionIndex: number }
  >();
  protected pendingTodos = new Map<
    string,
    { chatId: string; messageId: number }
  >();
  protected activeDraftStreams = new Map<string, ActiveDraftStreamState>();
  protected activeGroupStreams = new Map<string, ActiveGroupStreamState>();
  protected streamGenerationByJid = new Map<string, number>();
  protected sealedStreamGenerationByJid = new Map<string, number>();
  protected activeProgressMessages = new Map<string, ActiveProgressState>();
  protected sealedProgressGenerationByKey = new Map<string, number>();
  private progressStateLoaded = false;
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

  supportsInteractionCallbacks(): boolean {
    return this.interactionCallbacksEnabled;
  }

  protected nextPermissionCallbackId(): string {
    for (let attempts = 0; attempts < 1000; attempts += 1) {
      this.permissionCallbackCounter =
        (this.permissionCallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
      const id = `p${this.permissionCallbackCounter.toString(36)}`;
      if (!this.pendingPermissionCallbackIds.has(id)) return id;
    }
    throw new Error('Unable to allocate Telegram permission callback id');
  }

  protected permissionCallbackIdForRequest(requestId: string): string {
    return `p${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
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

  protected loadPersistedProgressMessages(): void {
    if (this.progressStateLoaded) return;
    this.progressStateLoaded = true;
    const entries = readProgressStateEntries(
      this.progressStateFilePath(),
      'Telegram',
    ) as unknown as Array<[string, ActiveProgressState]>;
    for (const [key, state] of entries) {
      if (
        typeof state.chatId === 'string' &&
        typeof state.lastText === 'string'
      ) {
        this.activeProgressMessages.set(key, state);
      }
    }
  }

  protected persistProgressMessages(): void {
    writeProgressStateEntries(
      this.progressStateFilePath(),
      'Telegram',
      this.activeProgressMessages.entries(),
    );
  }

  protected shouldAcceptProgressUpdate(
    key: string,
    generation?: number,
    done?: boolean,
  ): boolean {
    if (done || generation === undefined) return true;
    const sealed = this.sealedProgressGenerationByKey.get(key);
    return sealed === undefined || generation > sealed;
  }

  protected markProgressGenerationDone(key: string, generation?: number): void {
    if (generation === undefined) return;
    const sealed = this.sealedProgressGenerationByKey.get(key);
    if (sealed === undefined || generation > sealed) {
      this.sealedProgressGenerationByKey.set(key, generation);
    }
  }

  private progressStateFilePath(): string | null {
    return channelProgressStateFilePath('telegram', this.botToken);
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

    const now = currentTimeMs();
    const shouldFlush =
      options.done ||
      !state.messageId ||
      now - state.lastFlushAt >= TELEGRAM_GROUP_EDIT_INTERVAL_MS;
    const parts = splitTelegramDeliveryText(renderedBuffer);
    const headText = parts[0] ?? '';
    const overflowParts = parts.slice(1).filter((part) => part.length > 0);
    const overflowText = parts.slice(1).join('');

    try {
      if (shouldFlush) {
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
              { preserveStyleMarkers: true },
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
              logger.info(
                { jid, messageId, length: headText.length },
                'Telegram group stream message sent',
              );
            }
          }
        } else if (options.done) {
          // Final edit — apply MarkdownV2 formatting
          await editTelegramMessage(
            this.bot.api,
            numericId,
            state.messageId,
            headText,
            { preserveStyleMarkers: true },
          );
          delivered = true;
          logger.info(
            { jid, messageId: state.messageId, length: headText.length },
            'Telegram group stream message finalized',
          );
        } else {
          // Intermediate edits — plain text, single API call, no fallback cascade
          try {
            await this.bot.api.editMessageText(
              numericId,
              state.messageId,
              headText,
            );
            delivered = true;
            logger.debug(
              { jid, messageId: state.messageId, length: headText.length },
              'Telegram group stream message updated',
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
          if (
            overflowParts.length > 0 &&
            this.isCurrentStreamingGeneration(jid, options.generation)
          ) {
            const sendOptions = state.threadId
              ? { message_thread_id: state.threadId }
              : {};
            for (const part of overflowParts) {
              await sendTelegramMessageWithResult(
                this.bot.api,
                numericId,
                part,
                sendOptions,
                { preserveStyleMarkers: true },
              );
              delivered = true;
            }
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
        if (state.messageId) {
          const headExternalMessageId = String(state.messageId);
          const visibleExternalMessageIds = [headExternalMessageId];
          const sendOptions = state.threadId
            ? { message_thread_id: state.threadId }
            : {};
          if (
            overflowParts.length > 0 &&
            this.isCurrentStreamingGeneration(jid, options.generation)
          ) {
            const sentOverflowMessageIds: string[] = [];
            try {
              for (const part of overflowParts) {
                const messageId = await sendTelegramMessageWithResult(
                  this.bot.api,
                  numericId,
                  part,
                  sendOptions,
                  { preserveStyleMarkers: true },
                );
                if (messageId !== undefined) {
                  const externalMessageId = String(messageId);
                  sentOverflowMessageIds.push(externalMessageId);
                  visibleExternalMessageIds.push(externalMessageId);
                }
                delivered = true;
              }
              this.activeGroupStreams.delete(key);
              this.markStreamingGenerationDone(jid, options.generation);
              return delivered || Boolean(state.messageId);
            } catch (tailErr) {
              const unsentOverflowText = overflowParts
                .slice(sentOverflowMessageIds.length)
                .join('');
              const deliveredVisibleParts = visibleExternalMessageIds.length;
              const totalVisibleParts = 1 + overflowParts.length;
              const partial = new PartialMessageDeliveryError({
                cause: tailErr,
                deliveredChunks: deliveredVisibleParts,
                name: 'PartialTelegramGroupFinalEditDeliveryError',
                message:
                  'Telegram group stream partially delivered after final edit failure',
                totalChunks: totalVisibleParts,
              });
              Object.assign(partial, {
                provider: 'telegram',
                deliveredParts: deliveredVisibleParts,
                totalParts: totalVisibleParts,
                externalMessageId: headExternalMessageId,
                externalMessageIds: visibleExternalMessageIds,
                ...(unsentOverflowText.trim()
                  ? {
                      retryTail: {
                        canonicalText: unsentOverflowText,
                        providerPayload: {
                          provider: 'telegram',
                          chatId: numericId,
                          externalMessageId: headExternalMessageId,
                          externalMessageIds: visibleExternalMessageIds,
                          ...(state.threadId
                            ? { threadId: String(state.threadId) }
                            : {}),
                        },
                      },
                    }
                  : {}),
              });
              this.activeGroupStreams.delete(key);
              this.markStreamingGenerationDone(jid, options.generation);
              throw partial;
            }
          }
          const partial = new PartialMessageDeliveryError({
            cause: err,
            deliveredChunks: 1,
            name: 'PartialTelegramGroupFinalEditDeliveryError',
            message:
              'Telegram group stream partially delivered after final edit failure',
            totalChunks: 2,
          });
          if (overflowText.trim()) {
            Object.assign(partial, {
              provider: 'telegram',
              deliveredParts: 1,
              totalParts: 2,
              externalMessageId: headExternalMessageId,
              externalMessageIds: visibleExternalMessageIds,
              retryTail: {
                canonicalText: overflowText,
                providerPayload: {
                  provider: 'telegram',
                  chatId: numericId,
                  externalMessageId: headExternalMessageId,
                  externalMessageIds: visibleExternalMessageIds,
                  ...(state.threadId
                    ? { threadId: String(state.threadId) }
                    : {}),
                },
              },
            });
          } else {
            Object.assign(partial, {
              provider: 'telegram',
              deliveredParts: 1,
              totalParts: 2,
              externalMessageId: headExternalMessageId,
              externalMessageIds: visibleExternalMessageIds,
            });
          }
          this.activeGroupStreams.delete(key);
          this.markStreamingGenerationDone(jid, options.generation);
          throw partial;
        }
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
      if (
        overflowParts.length > 0 &&
        this.isCurrentStreamingGeneration(jid, options.generation)
      ) {
        const sendOptions = state.threadId
          ? { message_thread_id: state.threadId }
          : {};
        for (const part of overflowParts) {
          await sendTelegramMessageWithResult(
            this.bot.api,
            numericId,
            part,
            sendOptions,
            { preserveStyleMarkers: true },
          );
          delivered = true;
        }
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
  ): Promise<MessageDeliveryResult>;
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
