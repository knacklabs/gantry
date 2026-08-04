import { isPartialMessageDeliveryError } from '../domain/messages/partial-delivery.js';
import { logger } from '../infrastructure/logging/logger.js';
import { discordActionComponents } from './discord-components.js';
import { formatDiscordAgentTodo, postDiscordMessageParts, splitDiscordText, } from './discord-delivery.js';
import { sendDiscordProgressUpdate } from './discord-progress.js';
import { DiscordGatewayConnection } from './discord-gateway.js';
import { agentTodoStopActions } from './agent-todo-render.js';
import { CHANNEL_STREAM_UPDATE_INTERVAL_MS } from './channel-provider.js';
import { getProviderRuntimeSecret } from './provider-runtime-secrets.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { discordMessageAttachments, hydrateDiscordConversationContext, resolveDiscordConversationContext, } from './discord-conversation-context.js';
import { DiscordInteractionHandler } from './discord-interactions.js';
import { discordHeaders, discordRateLimitRetryDelayMs, discordReactionEmoji, userName, waitDiscordRetryDelay, } from './discord-http-helpers.js';
import { StreamResetEpochs } from './stream-reset-epochs.js';
export const DISCORD_JID_PREFIX = 'dc:';
const DISCORD_API_ROOT = 'https://discord.com/api/v10';
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DISCORD_MESSAGE_CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000;
const DISCORD_MESSAGE_CHANNEL_CACHE_MAX_ENTRIES = 5000;
export function normalizeDiscordJid(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    return trimmed.startsWith(DISCORD_JID_PREFIX)
        ? trimmed
        : `${DISCORD_JID_PREFIX}${trimmed}`;
}
export function discordChannelIdFromJid(jid) {
    const normalized = normalizeDiscordJid(jid);
    return normalized ? normalized.slice(DISCORD_JID_PREFIX.length) : null;
}
function websocketFactory(url) {
    return new WebSocket(url);
}
export class DiscordChannel {
    botToken;
    applicationId;
    opts;
    createWebSocket;
    name = 'discord';
    gateway = null;
    botUserId = '';
    activeProgressMessages = new Map();
    activeStreams = new Map();
    streamGenerationByJid = new Map();
    sealedStreamGenerationByJid = new Map();
    streamResetEpochs = new StreamResetEpochs();
    pendingTodos = new Map();
    reactionKeys = new Set();
    messageChannelIds = new Map();
    channelContextCache = new Map();
    interactions;
    constructor(botToken, applicationId, opts, createWebSocket = websocketFactory) {
        this.botToken = botToken;
        this.applicationId = applicationId;
        this.opts = opts;
        this.createWebSocket = createWebSocket;
        this.interactions = new DiscordInteractionHandler({
            botToken,
            applicationId,
            opts,
            postMessage: (channelId, body) => this.postMessage(channelId, body),
            sendMessage: (jid, text, options) => this.sendMessage(jid, text, options),
            resolveInteractionConversationContext: (channelId) => this.resolveInteractionConversationContext(channelId),
        });
    }
    ownsJid(jid) {
        return jid.trim().startsWith(DISCORD_JID_PREFIX);
    }
    async connect(options = {}) {
        if (options.inbound === false)
            return;
        this.gateway = new DiscordGatewayConnection({
            botToken: this.botToken,
            apiRoot: DISCORD_API_ROOT,
            intents: DISCORD_GATEWAY_INTENTS,
            createWebSocket: this.createWebSocket,
            onDispatch: (payload) => this.handleGatewayDispatch(payload),
        });
        await this.gateway.connect();
    }
    isConnected() {
        return this.gateway?.isConnected() ?? false;
    }
    async disconnect() {
        await this.interactions.clearPendingInteractions();
        this.gateway?.disconnect();
        this.gateway = null;
    }
    async sendMessage(jid, text, options = {}) {
        const channelId = options.threadId || discordChannelIdFromJid(jid);
        if (!channelId)
            throw new Error(`Invalid Discord conversation id: ${jid}`);
        return postDiscordMessageParts({
            channelId,
            parts: splitDiscordText(text),
            components: discordActionComponents(options),
            files: options.files,
            apiRoot: DISCORD_API_ROOT,
            botToken: this.botToken,
            post: (target, body) => this.postMessage(target, body),
        });
    }
    async renderRichInteraction(jid, render) {
        return this.interactions.renderRichInteraction(jid, render);
    }
    async addReaction(jid, messageRef, emoji) {
        const parentChannelId = discordChannelIdFromJid(jid);
        const channelId = this.resolveMessageChannelId(this.messageChannelKey(jid, messageRef)) ||
            parentChannelId;
        if (!channelId || !messageRef.trim())
            return;
        const reaction = discordReactionEmoji(emoji);
        const key = `${channelId}:${messageRef}:${reaction}`;
        if (this.reactionKeys.has(key))
            return;
        try {
            await this.requestJson(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageRef)}/reactions/${encodeURIComponent(reaction)}/@me`, {
                method: 'PUT',
                headers: discordHeaders(this.botToken),
            }, 'Discord reaction update failed', false);
            this.reactionKeys.add(key);
        }
        catch (err) {
            logger.debug({ jid, messageRef, err }, 'Discord reaction update failed');
        }
    }
    async hydrateConversationContext(request) {
        return hydrateDiscordConversationContext({
            request,
            botToken: this.botToken,
            botUserId: this.botUserId,
            cache: this.channelContextCache,
            headers: discordHeaders,
            requestJson: (path, init, errorMessage, parseJson) => this.requestJson(path, init, errorMessage, parseJson),
        });
    }
    async sendProgressUpdate(jid, text, options = {}) {
        const channelId = options.threadId || discordChannelIdFromJid(jid);
        if (!channelId)
            return;
        const generationKey = `${jid}\n${options.threadId ?? ''}\n${options.generation ?? ''}`;
        const controlKey = `${jid}\n${options.threadId ?? ''}\ncontrol`;
        const hasStopAction = options.actionAffordances?.some((action) => action.kind === 'live_turn_stop');
        const progressKey = hasStopAction ||
            (options.done && this.activeProgressMessages.has(controlKey))
            ? controlKey
            : generationKey;
        await sendDiscordProgressUpdate({
            key: progressKey,
            activeMessages: this.activeProgressMessages,
            text,
            options,
            post: (body, components) => postDiscordMessageParts({
                channelId,
                parts: splitDiscordText(body),
                components,
                post: (target, payload) => this.postMessage(target, payload),
            }),
            edit: (messageId, body) => this.patchMessage(channelId, messageId, body),
        });
    }
    async sendStreamingChunk(jid, text, options = {}) {
        const channelId = options.threadId || discordChannelIdFromJid(jid);
        if (!channelId)
            return false;
        if (!this.shouldAcceptStreamingChunk(jid, options.generation))
            return false;
        const key = `${jid}\n${options.threadId ?? ''}`;
        const streamEpoch = this.streamResetEpochs.current(key);
        let state = this.activeStreams.get(key);
        if (!state) {
            state = { channelId, rawBuffer: '', lastFlushAt: 0 };
            this.activeStreams.set(key, state);
        }
        if (text)
            state.rawBuffer += text;
        if (!state.rawBuffer.trim() && options.done) {
            this.streamResetEpochs.deleteState(key, this.activeStreams);
            this.markStreamingGenerationDone(jid, options.generation);
            return false;
        }
        const now = currentTimeMs();
        const shouldFlush = options.done ||
            !state.messageId ||
            now - state.lastFlushAt >= CHANNEL_STREAM_UPDATE_INTERVAL_MS.discord;
        if (!shouldFlush)
            return Boolean(state.messageId);
        const parts = splitDiscordText(state.rawBuffer);
        const headText = parts[0] ?? ' ';
        try {
            const body = {
                content: headText,
                allowed_mentions: { parse: [] },
                components: options.done ? [] : undefined,
            };
            if (state.messageId) {
                await this.patchMessage(state.channelId, state.messageId, body);
            }
            else {
                const posted = await this.postMessage(state.channelId, body);
                state.messageId = posted.id;
            }
            if (!this.streamResetEpochs.isCurrent(key, streamEpoch))
                return true;
            state.lastFlushAt = now;
            if (options.done) {
                const overflowParts = parts.slice(1).filter((part) => part.length > 0);
                if (overflowParts.length > 0)
                    await postDiscordMessageParts({
                        channelId: state.channelId,
                        parts: overflowParts,
                        post: (target, body) => this.postMessage(target, body),
                        shouldContinue: () => this.streamResetEpochs.isCurrent(key, streamEpoch),
                    });
                if (!this.streamResetEpochs.isCurrent(key, streamEpoch))
                    return true;
                this.streamResetEpochs.deleteState(key, this.activeStreams);
                this.markStreamingGenerationDone(jid, options.generation);
            }
            else {
                if (!this.streamResetEpochs.isCurrent(key, streamEpoch))
                    return true;
                this.activeStreams.set(key, state);
            }
            return true;
        }
        catch (err) {
            if (isPartialMessageDeliveryError(err))
                throw err;
            logger.warn({ jid, err }, 'Discord streaming update failed; preserving current stream state');
            if (options.done)
                return false;
            return Boolean(state.messageId);
        }
    }
    resetStreaming(jid, options) {
        if (options) {
            const key = `${jid}\n${options.threadId ?? ''}`;
            this.streamResetEpochs.bump(key);
            this.streamResetEpochs.deleteState(key, this.activeStreams);
            return;
        }
        this.streamResetEpochs.bumpMatching(this.activeStreams.keys(), `${jid}\n`);
        this.sealStreamingGenerationOnReset(jid);
        this.clearStreamingStateForJid(jid);
    }
    clearStreamingStateForJid(jid) {
        for (const key of this.activeStreams.keys()) {
            if (!key.startsWith(`${jid}\n`))
                continue;
            this.streamResetEpochs.deleteState(key, this.activeStreams);
        }
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
    markStreamingGenerationDone(jid, generation) {
        if (generation === undefined)
            return;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed === undefined || generation > sealed) {
            this.sealedStreamGenerationByJid.set(jid, generation);
        }
    }
    sealStreamingGenerationOnReset(jid) {
        const latest = this.streamGenerationByJid.get(jid);
        if (latest === undefined)
            return;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed === undefined || latest > sealed) {
            this.sealedStreamGenerationByJid.set(jid, latest);
        }
    }
    async renderAgentTodo(jid, render) {
        const channelId = render.threadId || discordChannelIdFromJid(jid);
        if (!channelId)
            return false;
        const todoKey = `${jid}:${render.cardKind ?? 'todo'}:${render.threadId || ''}`;
        const components = discordActionComponents({
            actionAffordances: render.threadId
                ? undefined
                : agentTodoStopActions(render),
        }) ?? [];
        const body = {
            content: formatDiscordAgentTodo(render),
            allowed_mentions: { parse: [] },
            components,
        };
        const existing = this.pendingTodos.get(todoKey);
        if (existing) {
            try {
                await this.patchMessage(existing.channelId, existing.messageId, body);
                return true;
            }
            catch (err) {
                logger.debug({ jid, threadId: render.threadId, err }, 'Discord todo update failed; posting a fresh message');
                this.pendingTodos.delete(todoKey);
            }
        }
        const posted = await this.postMessage(channelId, body);
        if (posted.id) {
            this.pendingTodos.set(todoKey, { channelId, messageId: posted.id });
            return true;
        }
        return false;
    }
    async requestPermissionApproval(jid, request, onPromptDelivered) {
        return this.interactions.requestPermissionApproval(jid, request, onPromptDelivered);
    }
    async requestUserAnswer(jid, request, onPromptDelivered) {
        return this.interactions.requestUserAnswer(jid, request, onPromptDelivered);
    }
    async cancelPendingPermission(cancellation) {
        return this.interactions.cancelPendingPermission(cancellation);
    }
    async cancelPendingQuestion(cancellation) {
        return this.interactions.cancelPendingQuestion(cancellation);
    }
    dropPendingInteraction(kind, request) {
        this.interactions.dropPendingInteraction(kind, request);
    }
    async requestJson(path, init, errorMessage, parseJson = true) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const response = await fetch(`${DISCORD_API_ROOT}${path}`, init);
            if (response.ok) {
                return parseJson ? (await response.json()) : undefined;
            }
            const retryDelayMs = discordRateLimitRetryDelayMs(response);
            if (retryDelayMs === null || attempt >= 2)
                throw new Error(errorMessage);
            logger.warn({ path, attempt: attempt + 1, retryDelayMs }, 'Discord REST request rate-limited; retrying');
            await waitDiscordRetryDelay(retryDelayMs);
        }
        throw new Error(errorMessage);
    }
    async postJson(path, body) {
        return this.requestJson(path, {
            method: 'POST',
            headers: discordHeaders(this.botToken),
            body: JSON.stringify(body),
        }, `Discord REST request failed: ${path}`);
    }
    async postMessage(channelId, body) {
        return this.postJson(`/channels/${encodeURIComponent(channelId)}/messages`, body);
    }
    async patchMessage(channelId, messageId, body) {
        await this.requestJson(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
            method: 'PATCH',
            headers: discordHeaders(this.botToken),
            body: JSON.stringify(body),
        }, 'Discord message edit failed', false);
    }
    async handleGatewayDispatch(payload) {
        if (payload.t === 'READY') {
            const ready = payload.d;
            this.botUserId = ready.user?.id || '';
            return;
        }
        if (payload.t === 'MESSAGE_CREATE') {
            await this.handleMessageCreate(payload.d);
            return;
        }
        if (payload.t === 'INTERACTION_CREATE') {
            await this.interactions.handleInteraction(payload.d);
        }
    }
    async handleMessageCreate(message) {
        if (!message.channel_id || !message.id)
            return;
        const author = message.author || message.member?.user;
        if (author?.bot || author?.id === this.botUserId)
            return;
        const attachments = discordMessageAttachments(message);
        const context = await this.resolveInteractionConversationContext(message.channel_id);
        if (context.threadId) {
            this.rememberMessageChannelId(context.conversationJid, message.id, message.channel_id);
        }
        const metadataArgs = [
            context.conversationJid,
            message.timestamp || new Date().toISOString(),
            undefined,
            'discord',
            true,
        ];
        if (this.opts.providerAccountId) {
            await this.opts.onChatMetadata(...metadataArgs, {
                providerAccountId: this.opts.providerAccountId,
            });
        }
        else {
            await this.opts.onChatMetadata(...metadataArgs);
        }
        await this.opts.onMessage(context.conversationJid, {
            id: message.id,
            chat_jid: context.conversationJid,
            provider: 'discord',
            sender: author?.id || 'unknown',
            sender_name: message.member?.nick || userName(author),
            content: message.content || '',
            timestamp: message.timestamp || new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
            thread_id: context.threadId,
            external_message_id: message.id,
            reply_to_message_id: message.referenced_message?.id,
            reply_to_message_content: message.referenced_message?.content,
            reply_to_sender_name: userName(message.referenced_message?.author, ''),
            ...(attachments.length > 0 ? { attachments } : {}),
        });
    }
    messageChannelKey(jid, messageRef) {
        return `${jid.trim()}:${messageRef.trim()}`;
    }
    rememberMessageChannelId(jid, messageRef, channelId) {
        const now = currentTimeMs();
        const key = this.messageChannelKey(jid, messageRef);
        this.messageChannelIds.delete(key);
        this.messageChannelIds.set(key, {
            channelId,
            expiresAtMs: now + DISCORD_MESSAGE_CHANNEL_CACHE_TTL_MS,
        });
        this.pruneMessageChannelIds(now);
    }
    resolveMessageChannelId(key) {
        const entry = this.messageChannelIds.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAtMs <= currentTimeMs()) {
            this.messageChannelIds.delete(key);
            return undefined;
        }
        return entry.channelId;
    }
    pruneMessageChannelIds(now) {
        for (const [key, entry] of this.messageChannelIds) {
            if (entry.expiresAtMs <= now)
                this.messageChannelIds.delete(key);
        }
        while (this.messageChannelIds.size > DISCORD_MESSAGE_CHANNEL_CACHE_MAX_ENTRIES) {
            const oldestKey = this.messageChannelIds.keys().next().value;
            if (!oldestKey)
                break;
            this.messageChannelIds.delete(oldestKey);
        }
    }
    resolveInteractionConversationContext(channelId) {
        return resolveDiscordConversationContext({
            channelId,
            botToken: this.botToken,
            cache: this.channelContextCache,
            headers: discordHeaders,
            requestJson: (path, init, errorMessage, parseJson) => this.requestJson(path, init, errorMessage, parseJson),
        });
    }
}
export async function createDiscordChannel(opts) {
    const settings = opts.runtimeSettings?.();
    const botToken = await getProviderRuntimeSecret({
        providerId: 'discord',
        providerAccountId: opts.providerAccountId ?? '',
        key: 'bot_token',
        settings,
        secrets: opts.runtimeSecrets,
    });
    const applicationId = await getProviderRuntimeSecret({
        providerId: 'discord',
        providerAccountId: opts.providerAccountId ?? '',
        key: 'application_id',
        settings,
        secrets: opts.runtimeSecrets,
    });
    if (!botToken || !applicationId) {
        logger.warn('Discord: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required');
        return null;
    }
    return new DiscordChannel(botToken, applicationId, opts);
}
