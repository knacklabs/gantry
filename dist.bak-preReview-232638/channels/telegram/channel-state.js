import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { AsyncTaskQueue } from '../../app/bootstrap/async-task-queue.js';
import { TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY, TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX, TELEGRAM_GROUP_EDIT_INTERVAL_MS, formatTelegramStreamingText, sendTelegramMessageWithResult, editTelegramMessage, sanitizeTelegramErrorMessage, splitTelegramDeliveryText, } from './channel-shared.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { channelProgressStateFilePath, readProgressStateEntries, writeProgressStateEntries, } from '../progress-state-file.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { StreamResetEpochs } from '../stream-reset-epochs.js';
import { dropPendingTelegramInteraction } from './disconnect.js';
import { cancelPendingTelegramPermission, } from './channel-permission-cancellation.js';
import { sanitizeTelegramFilePath } from './channel-file-path.js';
export class TelegramChannelState {
    name = 'telegram';
    bot = null;
    draftStreamApi = null;
    isStopping = false;
    pollingRetryTimer = null;
    pollingLease = null;
    pollingStartInFlight = false;
    interactionCallbacksEnabled = true;
    opts;
    botToken;
    pendingPermissionPrompts = new Map();
    pendingUserQuestionCallbackIds = new Map();
    pendingUserQuestions = new Map();
    pendingUserQuestionOtherPrompts = new Map();
    pendingTodos = new Map();
    activeDraftStreams = new Map();
    activeGroupStreams = new Map();
    streamGenerationByJid = new Map();
    sealedStreamGenerationByJid = new Map();
    streamResetEpochs = new StreamResetEpochs();
    activeProgressMessages = new Map();
    sealedProgressGenerationByKey = new Map();
    progressStateLoaded = false;
    mediaIngestionQueue = new AsyncTaskQueue(TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY, TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX, TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX);
    nextDraftIdOffset = 1;
    dropPendingInteraction(kind, request) {
        dropPendingTelegramInteraction(kind, request, this.pendingPermissionPrompts, this.pendingUserQuestions, this.pendingUserQuestionCallbackIds, this.pendingUserQuestionOtherPrompts);
    }
    async cancelPendingPermission(cancellation) {
        return cancelPendingTelegramPermission(this.pendingPermissionPrompts, cancellation, (providerAlias, reason) => this.claimAndResolvePermissionPrompt(providerAlias, 'cancel', 'runtime', reason));
    }
    constructor(botToken, opts) {
        this.botToken = botToken;
        this.opts = opts;
    }
    supportsInteractionCallbacks() {
        return this.interactionCallbacksEnabled;
    }
    sanitizeErrorMessage(err) {
        return sanitizeTelegramErrorMessage(err, this.botToken);
    }
    sanitizeTelegramFilePath(rawPath) {
        return sanitizeTelegramFilePath(rawPath);
    }
    clearPollingRetryTimer() {
        if (!this.pollingRetryTimer)
            return;
        clearTimeout(this.pollingRetryTimer);
        this.pollingRetryTimer = null;
    }
    buildDraftStreamKey(jid, threadId) {
        return `${jid}:${threadId || ''}`;
    }
    loadPersistedProgressMessages() {
        if (this.progressStateLoaded)
            return;
        this.progressStateLoaded = true;
        const entries = readProgressStateEntries(this.progressStateFilePath(), 'Telegram');
        for (const [key, state] of entries) {
            if (typeof state.chatId === 'string' &&
                typeof state.lastText === 'string') {
                this.activeProgressMessages.set(key, { ...state, restored: true });
            }
        }
    }
    persistProgressMessages() {
        writeProgressStateEntries(this.progressStateFilePath(), 'Telegram', this.activeProgressMessages.entries());
    }
    shouldAcceptProgressUpdate(key, generation, done) {
        if (done || generation === undefined)
            return true;
        const sealed = this.sealedProgressGenerationByKey.get(key);
        return sealed === undefined || generation > sealed;
    }
    markProgressGenerationDone(key, generation) {
        if (generation === undefined)
            return;
        const sealed = this.sealedProgressGenerationByKey.get(key);
        if (sealed === undefined || generation > sealed) {
            this.sealedProgressGenerationByKey.set(key, generation);
        }
    }
    progressStateFilePath() {
        return channelProgressStateFilePath('telegram', this.botToken);
    }
    clearStreamingStateForJid(jid) {
        for (const [key, state] of this.activeDraftStreams.entries()) {
            if (!key.startsWith(`${jid}:`))
                continue;
            state.closeStream();
            this.streamResetEpochs.deleteState(key, this.activeDraftStreams);
        }
        for (const key of this.activeGroupStreams.keys()) {
            if (!key.startsWith(`${jid}:`))
                continue;
            this.streamResetEpochs.deleteState(key, this.activeGroupStreams);
        }
    }
    resetStreaming(jid, options) {
        if (options) {
            const key = this.buildDraftStreamKey(jid, options.threadId);
            this.streamResetEpochs.bump(key);
            this.activeDraftStreams.get(key)?.closeStream();
            this.streamResetEpochs.deleteState(key, this.activeDraftStreams);
            this.streamResetEpochs.deleteState(key, this.activeGroupStreams);
            return;
        }
        const prefix = `${jid}:`;
        this.streamResetEpochs.bumpMatching(this.activeDraftStreams.keys(), prefix);
        this.streamResetEpochs.bumpMatching(this.activeGroupStreams.keys(), prefix);
        this.sealStreamingGenerationOnReset(jid);
        this.clearStreamingStateForJid(jid);
    }
    shouldAcceptStreamingChunk(jid, generation) {
        if (generation === undefined)
            return true;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed !== undefined && generation <= sealed)
            return false;
        const latest = this.streamGenerationByJid.get(jid);
        if (latest === undefined) {
            this.streamGenerationByJid.set(jid, generation);
            return true;
        }
        if (generation < latest)
            return false;
        if (generation > latest) {
            this.clearStreamingStateForJid(jid);
            this.streamGenerationByJid.set(jid, generation);
        }
        return true;
    }
    isCurrentStreamingGeneration(jid, generation) {
        if (generation === undefined)
            return true;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed !== undefined && generation <= sealed)
            return false;
        const latest = this.streamGenerationByJid.get(jid);
        if (latest === undefined)
            return true;
        return generation === latest;
    }
    markStreamingGenerationDone(jid, generation) {
        if (generation === undefined)
            return;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed === undefined || generation > sealed)
            this.sealedStreamGenerationByJid.set(jid, generation);
    }
    sealStreamingGenerationOnReset(jid) {
        this.markStreamingGenerationDone(jid, this.streamGenerationByJid.get(jid));
    }
    isLikelyPrivateChatId(numericId) {
        return !numericId.startsWith('-');
    }
    createDraftChunkStream() {
        const chunks = [];
        let closed = false;
        let resolver = null;
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
                        await new Promise((resolve) => {
                            resolver = resolve;
                        });
                        continue;
                    }
                    const next = chunks.shift();
                    if (next)
                        yield next;
                }
            })(),
            push: (chunk) => {
                if (!chunk)
                    return;
                chunks.push(chunk);
                wake();
            },
            close: () => {
                closed = true;
                wake();
            },
        };
    }
    telegramRateLimitRetryDelayMs(err) {
        const candidate = err;
        if (candidate.error_code !== 429 &&
            candidate.status !== 429 &&
            candidate.statusCode !== 429 &&
            candidate.response?.status !== 429) {
            return null;
        }
        const retryAfter = candidate.parameters?.retry_after ??
            candidate.response?.parameters?.retry_after;
        const seconds = typeof retryAfter === 'number'
            ? retryAfter
            : typeof retryAfter === 'string'
                ? Number.parseFloat(retryAfter)
                : Number.NaN;
        if (!Number.isFinite(seconds) || seconds <= 0)
            return 1000;
        return Math.min(5000, Math.max(1, Math.round(seconds * 1000)));
    }
    async withTelegramGroupRateLimitRetry(jid, action) {
        try {
            return await action();
        }
        catch (err) {
            const retryDelayMs = this.telegramRateLimitRetryDelayMs(err);
            if (retryDelayMs === null)
                throw err;
            logger.warn({ jid, retryDelayMs }, 'Telegram group stream rate-limited; retrying current flush');
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, retryDelayMs);
                timer.unref?.();
            });
            return action();
        }
    }
    async handleGroupStreamingChunk(jid, numericId, text, options) {
        if (!this.bot)
            return false;
        let delivered = false;
        const parsedThreadId = options.threadId
            ? Number.parseInt(options.threadId, 10)
            : undefined;
        const key = this.buildDraftStreamKey(jid, options.threadId);
        const streamEpoch = this.streamResetEpochs.current(key);
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
        const isCurrentState = () => this.streamResetEpochs.isCurrent(key, streamEpoch) &&
            this.activeGroupStreams.get(key) === state &&
            this.isCurrentStreamingGeneration(jid, options.generation);
        const finishCurrentState = () => {
            if (!isCurrentState())
                return;
            this.streamResetEpochs.deleteState(key, this.activeGroupStreams);
            this.markStreamingGenerationDone(jid, options.generation);
        };
        if (text)
            state.rawBuffer += text;
        const renderedBuffer = formatTelegramStreamingText(state.rawBuffer, options.done);
        const hasContent = renderedBuffer.trim().length > 0;
        if (!hasContent) {
            if (options.done)
                finishCurrentState();
            return false;
        }
        const now = currentTimeMs();
        const shouldFlush = options.done ||
            !state.messageId ||
            now - state.lastFlushAt >= TELEGRAM_GROUP_EDIT_INTERVAL_MS;
        const parts = splitTelegramDeliveryText(renderedBuffer);
        const headText = parts[0] ?? '';
        const overflowParts = parts.slice(1).filter((part) => part.length > 0);
        const overflowText = parts.slice(1).join('');
        try {
            if (shouldFlush) {
                if (!state.messageId) {
                    const sendOptions = state.threadId
                        ? { message_thread_id: state.threadId }
                        : {};
                    if (options.done) {
                        const messageId = await this.withTelegramGroupRateLimitRetry(jid, () => sendTelegramMessageWithResult(this.bot.api, numericId, headText, sendOptions, { preserveStyleMarkers: true }));
                        if (messageId) {
                            state.messageId = messageId;
                            delivered = true;
                        }
                    }
                    else {
                        const sent = await this.withTelegramGroupRateLimitRetry(jid, () => this.bot.api.sendMessage(numericId, headText, sendOptions));
                        const messageId = sent?.message_id;
                        if (messageId) {
                            state.messageId = messageId;
                            delivered = true;
                            logger.info({ jid, messageId, length: headText.length }, 'Telegram group stream message sent');
                        }
                    }
                }
                else if (options.done) {
                    await this.withTelegramGroupRateLimitRetry(jid, () => editTelegramMessage(this.bot.api, numericId, state.messageId, headText, { preserveStyleMarkers: true }));
                    delivered = true;
                    logger.info({ jid, messageId: state.messageId, length: headText.length }, 'Telegram group stream message finalized');
                }
                else {
                    try {
                        await this.withTelegramGroupRateLimitRetry(jid, () => this.bot.api.editMessageText(numericId, state.messageId, headText));
                        delivered = true;
                        logger.debug({ jid, messageId: state.messageId, length: headText.length }, 'Telegram group stream message updated');
                    }
                    catch (err) {
                        const msg = this.sanitizeErrorMessage(err);
                        if (!/message is not modified/i.test(msg)) {
                            logger.debug({ err: msg }, 'Streaming plain-text edit failed');
                        }
                    }
                }
                state.lastFlushAt = now;
            }
        }
        catch (err) {
            const sanitizedError = this.sanitizeErrorMessage(err);
            const isNotModified = /message is not modified/i.test(sanitizedError);
            if (isNotModified) {
                logger.debug({ jid, err: sanitizedError }, 'Telegram group stream update had no text changes');
                if (options.done) {
                    if (!isCurrentState())
                        return delivered || Boolean(state.messageId);
                    if (overflowParts.length > 0 && isCurrentState()) {
                        const sendOptions = state.threadId
                            ? { message_thread_id: state.threadId }
                            : {};
                        for (const part of overflowParts) {
                            if (!isCurrentState())
                                break;
                            await this.withTelegramGroupRateLimitRetry(jid, () => sendTelegramMessageWithResult(this.bot.api, numericId, part, sendOptions, { preserveStyleMarkers: true }));
                            delivered = true;
                        }
                    }
                    finishCurrentState();
                }
                return delivered || Boolean(state.messageId);
            }
            logger.warn({ jid, err: sanitizedError }, 'Telegram group stream update failed');
            if (options.done) {
                if (state.messageId) {
                    const headExternalMessageId = String(state.messageId);
                    const visibleExternalMessageIds = [headExternalMessageId];
                    const sendOptions = state.threadId
                        ? { message_thread_id: state.threadId }
                        : {};
                    if (overflowParts.length > 0 && isCurrentState()) {
                        const sentOverflowMessageIds = [];
                        try {
                            for (const part of overflowParts) {
                                if (!isCurrentState())
                                    break;
                                const messageId = await this.withTelegramGroupRateLimitRetry(jid, () => sendTelegramMessageWithResult(this.bot.api, numericId, part, sendOptions, { preserveStyleMarkers: true }));
                                if (messageId !== undefined) {
                                    const externalMessageId = String(messageId);
                                    sentOverflowMessageIds.push(externalMessageId);
                                    visibleExternalMessageIds.push(externalMessageId);
                                }
                                delivered = true;
                            }
                            finishCurrentState();
                            return delivered || Boolean(state.messageId);
                        }
                        catch (tailErr) {
                            const unsentOverflowText = overflowParts
                                .slice(sentOverflowMessageIds.length)
                                .join('');
                            const deliveredVisibleParts = visibleExternalMessageIds.length;
                            const totalVisibleParts = 1 + overflowParts.length;
                            const partial = new PartialMessageDeliveryError({
                                cause: tailErr,
                                deliveredChunks: deliveredVisibleParts,
                                name: 'PartialTelegramGroupFinalEditDeliveryError',
                                message: 'Telegram group stream partially delivered after final edit failure',
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
                            finishCurrentState();
                            throw partial;
                        }
                    }
                    const partial = new PartialMessageDeliveryError({
                        cause: err,
                        deliveredChunks: 1,
                        name: 'PartialTelegramGroupFinalEditDeliveryError',
                        message: 'Telegram group stream partially delivered after final edit failure',
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
                    }
                    else {
                        Object.assign(partial, {
                            provider: 'telegram',
                            deliveredParts: 1,
                            totalParts: 2,
                            externalMessageId: headExternalMessageId,
                            externalMessageIds: visibleExternalMessageIds,
                        });
                    }
                    finishCurrentState();
                    throw partial;
                }
                if (isCurrentState()) {
                    await this.sendMessage(jid, renderedBuffer, {
                        threadId: options.threadId,
                    });
                    delivered = true;
                }
                finishCurrentState();
            }
            return delivered || Boolean(state.messageId);
        }
        if (options.done) {
            if (!isCurrentState())
                return delivered || Boolean(state.messageId);
            if (overflowParts.length > 0 && isCurrentState()) {
                const sendOptions = state.threadId
                    ? { message_thread_id: state.threadId }
                    : {};
                for (const part of overflowParts) {
                    if (!isCurrentState())
                        break;
                    await this.withTelegramGroupRateLimitRetry(jid, () => sendTelegramMessageWithResult(this.bot.api, numericId, part, sendOptions, { preserveStyleMarkers: true }));
                    delivered = true;
                }
            }
            finishCurrentState();
        }
        return delivered || Boolean(state.messageId);
    }
    schedulePollingRetry() {
        if (this.isStopping || !this.bot || this.pollingRetryTimer)
            return;
        const retryDelayMs = 3000;
        logger.warn({ retryDelayMs }, 'Retrying Telegram polling');
        this.pollingRetryTimer = setTimeout(() => {
            this.pollingRetryTimer = null;
            this.startPolling();
        }, retryDelayMs);
    }
}
