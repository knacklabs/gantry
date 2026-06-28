import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import { isPartialMessageDeliveryError } from '../domain/messages/partial-delivery.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  bindPendingPermissionInteractionMessage,
  findDurablePermissionInteractionByRequestId,
  findDurableQuestionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionInteractionByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import {
  buildPermissionPromptParts,
  decisionForMode,
  formatPermissionPromptPartsText,
  permissionButtonLabel,
  permissionDecisionOptions,
  type PermissionPromptFullView,
} from './permission-interaction.js';
import {
  ChannelAdapter,
  ChannelOpts,
  type ConversationContextHydrationRequest,
  type ConversationContextHydrationResult,
} from './channel-provider.js';
import {
  buttonRows,
  discordActionComponents,
  LIVE_STOP_CUSTOM_ID_PREFIX,
  parsePermissionCustomId,
  parseQuestionCustomId,
  PERMISSION_CUSTOM_ID_PREFIX,
  permissionCustomId,
  QUESTION_CUSTOM_ID_PREFIX,
  questionComponents,
  SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX,
} from './discord-components.js';
import {
  formatDiscordAgentTodo,
  postDiscordMessageParts,
  splitDiscordText,
} from './discord-delivery.js';
import { sendDiscordProgressUpdate } from './discord-progress.js';
import { DiscordGatewayConnection } from './discord-gateway.js';
import { agentTodoStopActions } from './agent-todo-render.js';
import { CHANNEL_STREAM_UPDATE_INTERVAL_MS } from './channel-provider.js';
import { getProviderRuntimeSecret } from './provider-runtime-secrets.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import type {
  DiscordInteraction,
  DiscordInteractionOption,
  DiscordMessageCreate,
  DiscordUser,
  WebSocketFactory,
  WebSocketLike,
} from './discord-types.js';
import {
  discordMessageAttachments,
  hydrateDiscordConversationContext,
  resolveDiscordConversationContext,
  type DiscordConversationContextCache,
} from './discord-conversation-context.js';

export const DISCORD_JID_PREFIX = 'dc:';

const DISCORD_API_ROOT = 'https://discord.com/api/v10';
const DISCORD_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DISCORD_RETRY_DELAY_FALLBACK_MS = 1000;
const DISCORD_RETRY_DELAY_MAX_MS = 5000;
const DISCORD_PERMISSION_FULL_VIEW_PREFIX = 'gantry:perm_full:';
const DISCORD_MESSAGE_CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000;
const DISCORD_MESSAGE_CHANNEL_CACHE_MAX_ENTRIES = 5000;

type DiscordMessageChannelCacheEntry = {
  channelId: string;
  expiresAtMs: number;
};
const DISCORD_EPHEMERAL_MESSAGE_LIMIT = 1900;

export function normalizeDiscordJid(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(DISCORD_JID_PREFIX)
    ? trimmed
    : `${DISCORD_JID_PREFIX}${trimmed}`;
}

export function discordChannelIdFromJid(jid: string): string | null {
  const normalized = normalizeDiscordJid(jid);
  return normalized ? normalized.slice(DISCORD_JID_PREFIX.length) : null;
}

function discordHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bot ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

function discordReactionEmoji(emoji: string): string {
  if (emoji === 'seen') return '👀';
  if (emoji === 'running') return '⏳';
  return emoji;
}

function discordRateLimitRetryDelayMs(response: Response): number | null {
  if (response.status !== 429) return null;
  const retryAfter =
    response.headers.get('retry-after') ??
    response.headers.get('x-ratelimit-reset-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(
        DISCORD_RETRY_DELAY_MAX_MS,
        Math.max(1, Math.round(seconds * 1000)),
      );
    }
  }
  const resetSeconds = Number.parseFloat(
    response.headers.get('x-ratelimit-reset') ?? '',
  );
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    const delayMs = resetSeconds * 1000 - Date.now();
    if (delayMs > 0) {
      return Math.min(DISCORD_RETRY_DELAY_MAX_MS, Math.round(delayMs));
    }
  }
  return DISCORD_RETRY_DELAY_FALLBACK_MS;
}

async function waitDiscordRetryDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function userName(user: DiscordUser | undefined, fallback = 'unknown'): string {
  return user?.username || user?.id || fallback;
}

function discordSlashOptionText(option: DiscordInteractionOption): string {
  if (option.value === undefined || option.value === null) return '';
  return String(option.value).trim();
}

function discordGantrySlashText(interaction: DiscordInteraction): string {
  const subcommand = interaction.data?.options?.[0];
  const name = subcommand?.name?.trim() || 'help';
  const args = (subcommand?.options || [])
    .map(discordSlashOptionText)
    .filter(Boolean);
  return ['/gantry', name, ...args].join(' ');
}

function discordPermissionFullViewCustomId(requestId: string): string {
  return `${DISCORD_PERMISSION_FULL_VIEW_PREFIX}${encodeURIComponent(requestId)}`;
}

function discordPermissionFullViewRequestId(customId: string): string | null {
  if (!customId.startsWith(DISCORD_PERMISSION_FULL_VIEW_PREFIX)) return null;
  const raw = customId.slice(DISCORD_PERMISSION_FULL_VIEW_PREFIX.length);
  return raw ? decodeURIComponent(raw) : null;
}

function websocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  private gateway: DiscordGatewayConnection | null = null;
  private botUserId = '';
  private activeProgressMessages = new Map<string, string>();
  private activeStreams = new Map<
    string,
    {
      channelId: string;
      messageId?: string;
      rawBuffer: string;
      lastFlushAt: number;
    }
  >();
  private readonly streamGenerationByJid = new Map<string, number>();
  private readonly sealedStreamGenerationByJid = new Map<string, number>();
  private pendingPermissions = new Map<
    string,
    {
      request: PermissionApprovalRequest;
      resolve: (decision: PermissionApprovalDecision) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingQuestions = new Map<
    string,
    {
      request: UserQuestionRequest;
      answers: Record<string, string | string[]>;
      finalizedQuestions: Set<number>;
      resolve: (response: UserQuestionResponse) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingTodos = new Map<
    string,
    { channelId: string; messageId: string }
  >();
  private readonly reactionKeys = new Set<string>();
  private readonly messageChannelIds = new Map<
    string,
    DiscordMessageChannelCacheEntry
  >();
  private readonly channelContextCache: DiscordConversationContextCache =
    new Map();

  constructor(
    private readonly botToken: string,
    private readonly applicationId: string,
    private readonly opts: ChannelOpts,
    private readonly createWebSocket: WebSocketFactory = websocketFactory,
  ) {}

  ownsJid(jid: string): boolean {
    return jid.trim().startsWith(DISCORD_JID_PREFIX);
  }

  async connect(options: { inbound?: boolean } = {}): Promise<void> {
    if (options.inbound === false) return;
    this.gateway = new DiscordGatewayConnection({
      botToken: this.botToken,
      apiRoot: DISCORD_API_ROOT,
      intents: DISCORD_GATEWAY_INTENTS,
      createWebSocket: this.createWebSocket,
      onDispatch: (payload) => this.handleGatewayDispatch(payload),
    });
    await this.gateway.connect();
  }

  isConnected(): boolean {
    return this.gateway?.isConnected() ?? false;
  }

  async disconnect(): Promise<void> {
    this.clearPendingInteractions();
    this.gateway?.disconnect();
    this.gateway = null;
  }

  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<MessageDeliveryResult> {
    const channelId = options.threadId || discordChannelIdFromJid(jid);
    if (!channelId) throw new Error(`Invalid Discord conversation id: ${jid}`);
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

  async addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
  ): Promise<void> {
    const parentChannelId = discordChannelIdFromJid(jid);
    const channelId =
      this.resolveMessageChannelId(this.messageChannelKey(jid, messageRef)) ||
      parentChannelId;
    if (!channelId || !messageRef.trim()) return;
    const reaction = discordReactionEmoji(emoji);
    const key = `${channelId}:${messageRef}:${reaction}`;
    if (this.reactionKeys.has(key)) return;
    try {
      await this.requestJson<void>(
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageRef)}/reactions/${encodeURIComponent(reaction)}/@me`,
        {
          method: 'PUT',
          headers: discordHeaders(this.botToken),
        },
        'Discord reaction update failed',
        false,
      );
      this.reactionKeys.add(key);
    } catch (err) {
      logger.debug({ jid, messageRef, err }, 'Discord reaction update failed');
    }
  }

  async hydrateConversationContext(
    request: ConversationContextHydrationRequest,
  ): Promise<ConversationContextHydrationResult> {
    return hydrateDiscordConversationContext({
      request,
      botToken: this.botToken,
      botUserId: this.botUserId,
      cache: this.channelContextCache,
      headers: discordHeaders,
      requestJson: (path, init, errorMessage, parseJson) =>
        this.requestJson(path, init, errorMessage, parseJson),
    });
  }

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<void> {
    const channelId = options.threadId || discordChannelIdFromJid(jid);
    if (!channelId) return;
    const generationKey = `${jid}\n${options.threadId ?? ''}\n${options.generation ?? ''}`;
    const controlKey = `${jid}\n${options.threadId ?? ''}\ncontrol`;
    const hasStopAction = options.actionAffordances?.some(
      (action) => action.kind === 'live_turn_stop',
    );
    const progressKey =
      hasStopAction ||
      (options.done && this.activeProgressMessages.has(controlKey))
        ? controlKey
        : generationKey;
    await sendDiscordProgressUpdate({
      key: progressKey,
      activeMessages: this.activeProgressMessages,
      text,
      options,
      post: (body, components) =>
        postDiscordMessageParts({
          channelId,
          parts: splitDiscordText(body),
          components,
          post: (target, payload) => this.postMessage(target, payload),
        }),
      edit: (messageId, body) => this.patchMessage(channelId, messageId, body),
    });
  }

  async sendStreamingChunk(
    jid: string,
    text: string,
    options: StreamingChunkOptions = {},
  ): Promise<boolean> {
    const channelId = options.threadId || discordChannelIdFromJid(jid);
    if (!channelId) return false;
    if (!this.shouldAcceptStreamingChunk(jid, options.generation)) return false;
    const key = `${jid}\n${options.threadId ?? ''}`;
    let state = this.activeStreams.get(key);
    if (!state) {
      state = { channelId, rawBuffer: '', lastFlushAt: 0 };
      this.activeStreams.set(key, state);
    }
    if (text) state.rawBuffer += text;
    if (!state.rawBuffer.trim() && options.done) {
      this.activeStreams.delete(key);
      this.markStreamingGenerationDone(jid, options.generation);
      return false;
    }
    const now = currentTimeMs();
    const shouldFlush =
      options.done ||
      !state.messageId ||
      now - state.lastFlushAt >= CHANNEL_STREAM_UPDATE_INTERVAL_MS.discord;
    if (!shouldFlush) return Boolean(state.messageId);

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
      } else {
        const posted = await this.postMessage(state.channelId, body);
        state.messageId = posted.id;
      }
      state.lastFlushAt = now;
      if (options.done) {
        const overflowParts = parts.slice(1).filter((part) => part.length > 0);
        if (overflowParts.length > 0) {
          await postDiscordMessageParts({
            channelId: state.channelId,
            parts: overflowParts,
            post: (target, body) => this.postMessage(target, body),
          });
        }
        this.activeStreams.delete(key);
        this.markStreamingGenerationDone(jid, options.generation);
      } else {
        this.activeStreams.set(key, state);
      }
      return true;
    } catch (err) {
      if (isPartialMessageDeliveryError(err)) throw err;
      logger.warn(
        { jid, err },
        'Discord streaming update failed; preserving current stream state',
      );
      if (options.done) return false;
      return Boolean(state.messageId);
    }
  }

  resetStreaming(jid: string): void {
    this.sealStreamingGenerationOnReset(jid);
    this.clearStreamingStateForJid(jid);
  }

  private clearStreamingStateForJid(jid: string): void {
    for (const key of this.activeStreams.keys()) {
      if (key.startsWith(`${jid}\n`)) this.activeStreams.delete(key);
    }
  }

  private shouldAcceptStreamingChunk(
    jid: string,
    generation?: number,
  ): boolean {
    if (generation === undefined) return true;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed !== undefined && generation <= sealed) return false;
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) {
      this.streamGenerationByJid.set(jid, generation);
      return true;
    }
    if (generation < latest) return false;
    if (generation > latest) {
      this.clearStreamingStateForJid(jid);
      this.streamGenerationByJid.set(jid, generation);
    }
    return true;
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

  async renderAgentTodo(
    jid: string,
    render: AgentTodoRender,
  ): Promise<boolean> {
    const channelId = render.threadId || discordChannelIdFromJid(jid);
    if (!channelId) return false;
    const todoKey = `${jid}:${render.cardKind ?? 'todo'}:${render.threadId || ''}`;
    const components =
      discordActionComponents({
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
      } catch (err) {
        logger.debug(
          { jid, threadId: render.threadId, err },
          'Discord todo update failed; posting a fresh message',
        );
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

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    const modes = permissionDecisionOptions(request);
    const parts = buildPermissionPromptParts(
      request,
      DISCORD_INTERACTION_TIMEOUT_MS,
    );
    const buttons = [
      ...(parts.fullView
        ? [
            {
              label: parts.fullView.label,
              style: 2,
              custom_id: discordPermissionFullViewCustomId(request.requestId),
            },
          ]
        : []),
      ...modes.map((mode) => ({
        label: permissionButtonLabel(mode, request),
        style: mode === 'cancel' ? 4 : 1,
        custom_id: permissionCustomId(request.requestId, mode),
      })),
    ];
    const sent = await this.sendDiscordPrompt(
      jid,
      formatPermissionPromptPartsText(parts),
      {
        threadId: request.threadId,
        components: buttonRows(buttons),
      },
    );
    if (sent.externalMessageId) {
      await bindPendingPermissionInteractionMessage({
        sourceAgentFolder: request.sourceAgentFolder,
        requestId: request.requestId,
        appId: request.appId,
        externalMessageId: sent.externalMessageId,
        provider: 'discord',
        conversationId: discordChannelIdFromJid(jid) || jid,
        ...(request.threadId ? { threadId: request.threadId } : {}),
        fullView: parts.fullView,
      });
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(request.requestId);
        resolve({ approved: false, mode: 'cancel', reason: 'timed out' });
      }, DISCORD_INTERACTION_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingPermissions.set(request.requestId, {
        request,
        resolve,
        timeout,
      });
    });
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    if (request.questions.length === 0) {
      return { requestId: request.requestId, answers: {} };
    }
    for (
      let questionIndex = 0;
      questionIndex < request.questions.length;
      questionIndex += 1
    ) {
      const question = request.questions[questionIndex]!;
      const text = [
        `Question: ${question.question}`,
        ...question.options.map(
          (option, index) =>
            `${index + 1}. ${option.label}: ${option.description}`,
        ),
      ].join('\n');
      await this.sendDiscordPrompt(jid, text, {
        threadId: request.threadId,
        components: questionComponents(request, questionIndex),
      });
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingQuestions.delete(request.requestId);
        resolve({ requestId: request.requestId, answers: {} });
      }, DISCORD_INTERACTION_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingQuestions.set(request.requestId, {
        request,
        answers: {},
        finalizedQuestions: new Set<number>(),
        resolve,
        timeout,
      });
    });
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    errorMessage: string,
    parseJson = true,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${DISCORD_API_ROOT}${path}`, init);
      if (response.ok) {
        return parseJson ? ((await response.json()) as T) : (undefined as T);
      }
      const retryDelayMs = discordRateLimitRetryDelayMs(response);
      if (retryDelayMs === null || attempt >= 2) throw new Error(errorMessage);
      logger.warn(
        { path, attempt: attempt + 1, retryDelayMs },
        'Discord REST request rate-limited; retrying',
      );
      await waitDiscordRetryDelay(retryDelayMs);
    }
    throw new Error(errorMessage);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(
      path,
      {
        method: 'POST',
        headers: discordHeaders(this.botToken),
        body: JSON.stringify(body),
      },
      `Discord REST request failed: ${path}`,
    );
  }

  private async postMessage(
    channelId: string,
    body: Record<string, unknown>,
  ): Promise<{ id?: string }> {
    return this.postJson<{ id?: string }>(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      body,
    );
  }

  private async patchMessage(
    channelId: string,
    messageId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.requestJson<void>(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: discordHeaders(this.botToken),
        body: JSON.stringify(body),
      },
      'Discord message edit failed',
      false,
    );
  }

  private async sendDiscordPrompt(
    jid: string,
    text: string,
    options: { threadId?: string; components?: unknown[] } = {},
  ): Promise<MessageDeliveryResult> {
    const channelId = options.threadId || discordChannelIdFromJid(jid);
    if (!channelId) throw new Error(`Invalid Discord conversation id: ${jid}`);
    return postDiscordMessageParts({
      channelId,
      parts: splitDiscordText(text),
      components: options.components,
      post: (target, body) => this.postMessage(target, body),
    });
  }

  private async handleGatewayDispatch(payload: {
    t?: string | null;
    d?: unknown;
  }) {
    if (payload.t === 'READY') {
      const ready = payload.d as { user?: DiscordUser; session_id?: string };
      this.botUserId = ready.user?.id || '';
      return;
    }
    if (payload.t === 'MESSAGE_CREATE') {
      await this.handleMessageCreate(payload.d as DiscordMessageCreate);
      return;
    }
    if (payload.t === 'INTERACTION_CREATE') {
      await this.handleInteraction(payload.d as DiscordInteraction);
    }
  }

  private async handleMessageCreate(message: DiscordMessageCreate) {
    if (!message.channel_id || !message.id) return;
    const author = message.author || message.member?.user;
    if (author?.bot || author?.id === this.botUserId) return;
    const attachments = discordMessageAttachments(message);
    const context = await this.resolveInteractionConversationContext(
      message.channel_id,
    );
    if (context.threadId) {
      this.rememberMessageChannelId(
        context.conversationJid,
        message.id,
        message.channel_id,
      );
    }
    await this.opts.onChatMetadata(
      context.conversationJid,
      message.timestamp || new Date().toISOString(),
      undefined,
      'discord',
      true,
    );
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

  private messageChannelKey(jid: string, messageRef: string): string {
    return `${jid.trim()}:${messageRef.trim()}`;
  }

  private rememberMessageChannelId(
    jid: string,
    messageRef: string,
    channelId: string,
  ): void {
    const now = currentTimeMs();
    const key = this.messageChannelKey(jid, messageRef);
    this.messageChannelIds.delete(key);
    this.messageChannelIds.set(key, {
      channelId,
      expiresAtMs: now + DISCORD_MESSAGE_CHANNEL_CACHE_TTL_MS,
    });
    this.pruneMessageChannelIds(now);
  }

  private resolveMessageChannelId(key: string): string | undefined {
    const entry = this.messageChannelIds.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= currentTimeMs()) {
      this.messageChannelIds.delete(key);
      return undefined;
    }
    return entry.channelId;
  }

  private pruneMessageChannelIds(now: number): void {
    for (const [key, entry] of this.messageChannelIds) {
      if (entry.expiresAtMs <= now) this.messageChannelIds.delete(key);
    }
    while (
      this.messageChannelIds.size > DISCORD_MESSAGE_CHANNEL_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.messageChannelIds.keys().next().value;
      if (!oldestKey) break;
      this.messageChannelIds.delete(oldestKey);
    }
  }

  private async handleInteraction(interaction: DiscordInteraction) {
    if (!interaction.id || !interaction.token || !interaction.channel_id) {
      return;
    }
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith(LIVE_STOP_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking stop request.');
        const context = await this.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.opts.onMessageAction?.({
          kind: 'live_turn_stop',
          conversationJid: context.conversationJid,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          userId: interaction.member?.user?.id || interaction.user?.id,
          actionToken: customId.slice(LIVE_STOP_CUSTOM_ID_PREFIX.length),
        });
        return;
      }
      if (customId.startsWith(SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking retry request.');
        const context = await this.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.opts.onMessageAction?.({
          kind: 'scheduler_run_now',
          conversationJid: context.conversationJid,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          userId: interaction.member?.user?.id || interaction.user?.id,
          jobId: decodeURIComponent(
            customId.slice(SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX.length),
          ),
        });
        return;
      }
      if (customId.startsWith(PERMISSION_CUSTOM_ID_PREFIX)) {
        await this.handlePermissionInteraction(interaction, customId);
        return;
      }
      if (customId.startsWith(DISCORD_PERMISSION_FULL_VIEW_PREFIX)) {
        await this.handlePermissionFullViewInteraction(interaction, customId);
        return;
      }
      if (customId.startsWith(QUESTION_CUSTOM_ID_PREFIX)) {
        await this.handleQuestionInteraction(interaction, customId);
      }
      return;
    }
    if (interaction.type !== 2 || interaction.data?.name !== 'gantry') return;
    const commandText = discordGantrySlashText(interaction);
    await this.ackInteraction(interaction, `Gantry received ${commandText}.`);
    const user = interaction.member?.user || interaction.user;
    const context = await this.resolveInteractionConversationContext(
      interaction.channel_id,
    );
    await this.opts.onMessage(context.conversationJid, {
      id: interaction.id,
      chat_jid: context.conversationJid,
      provider: 'discord',
      sender: user?.id || 'unknown',
      sender_name: interaction.member?.nick || userName(user),
      content: commandText,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      thread_id: context.threadId,
      external_message_id: interaction.id,
    });
  }

  private resolveInteractionConversationContext(channelId: string) {
    return resolveDiscordConversationContext({
      channelId,
      botToken: this.botToken,
      cache: this.channelContextCache,
      headers: discordHeaders,
      requestJson: (path, init, errorMessage, parseJson) =>
        this.requestJson(path, init, errorMessage, parseJson),
    });
  }

  private async handlePermissionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ) {
    const parsed = parsePermissionCustomId(customId);
    const pending = parsed
      ? this.pendingPermissions.get(parsed.requestId)
      : undefined;
    if (!parsed) {
      await this.ackInteraction(
        interaction,
        'This approval is no longer active.',
      );
      return;
    }
    await this.ackInteraction(interaction, 'Processing.');
    const user = interaction.member?.user || interaction.user;
    if (!pending) {
      const durable = await findDurablePermissionInteractionByRequestId({
        requestId: parsed.requestId,
      });
      const allowed =
        durable?.targetJid ===
          `${DISCORD_JID_PREFIX}${interaction.channel_id}` &&
        (await this.isInteractionApproverAllowed(
          interaction,
          user?.id,
          durable.sourceAgentFolder,
          durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
        ));
      if (allowed) {
        await resolveDurablePermissionInteractionByRequestId({
          requestId: parsed.requestId,
          mode: parsed.mode,
          approverRef: user?.id,
          reason: 'resolved via Discord after channel restart',
        });
      }
      return;
    }
    const allowed = await this.isInteractionApproverAllowed(
      interaction,
      user?.id,
      pending.request.sourceAgentFolder,
    );
    if (!allowed) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(parsed.requestId);
    const decision = decisionForMode(pending.request, parsed.mode, user?.id);
    pending.resolve(decision);
  }

  private async handlePermissionFullViewInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    const requestId = discordPermissionFullViewRequestId(customId);
    if (!requestId) {
      await this.ackInteraction(
        interaction,
        'This approval is no longer active.',
      );
      return;
    }
    const pending = this.pendingPermissions.get(requestId);
    const user = interaction.member?.user || interaction.user;
    let fullView: PermissionPromptFullView | undefined;
    if (pending) {
      const allowed = await this.isInteractionApproverAllowed(
        interaction,
        user?.id,
        pending.request.sourceAgentFolder,
        pending.request.decisionPolicy,
      );
      if (!allowed) {
        await this.ackInteraction(
          interaction,
          'You are not allowed to view this approval payload.',
        );
        return;
      }
      fullView = buildPermissionPromptParts(
        pending.request,
        DISCORD_INTERACTION_TIMEOUT_MS,
      ).fullView;
    } else {
      const durable = await findDurablePermissionInteractionByRequestId({
        requestId,
      });
      if (
        !durable ||
        durable.targetJid !== `${DISCORD_JID_PREFIX}${interaction.channel_id}`
      ) {
        await this.ackInteraction(
          interaction,
          'This approval is no longer active.',
        );
        return;
      }
      const allowed = await this.isInteractionApproverAllowed(
        interaction,
        user?.id,
        durable.sourceAgentFolder,
        durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
      );
      if (!allowed) {
        await this.ackInteraction(
          interaction,
          'You are not allowed to view this approval payload.',
        );
        return;
      }
      fullView = durable.fullView;
    }
    if (!fullView) {
      await this.ackInteraction(
        interaction,
        'This approval has no full payload.',
      );
      return;
    }
    if (fullView.content.length <= DISCORD_EPHEMERAL_MESSAGE_LIMIT) {
      await this.ackInteraction(
        interaction,
        `${fullView.title}\n\`\`\`\n${fullView.content}\n\`\`\``,
      );
      return;
    }
    await this.deferEphemeralInteraction(interaction);
    await this.postDiscordInteractionFollowupFile(interaction, fullView);
  }

  private async handleQuestionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ) {
    const parsed = parseQuestionCustomId(customId);
    const pending = parsed
      ? this.pendingQuestions.get(parsed.requestId)
      : undefined;
    if (!parsed) {
      await this.ackInteraction(
        interaction,
        'This question is no longer active.',
      );
      return;
    }
    await this.ackInteraction(interaction, 'Processing.');
    const user = interaction.member?.user || interaction.user;
    if (!pending) {
      const durable = await findDurableQuestionInteractionByRequestId({
        requestId: parsed.requestId,
      });
      const allowed =
        durable?.targetJid ===
          `${DISCORD_JID_PREFIX}${interaction.channel_id}` &&
        (await this.isInteractionApproverAllowed(
          interaction,
          user?.id,
          durable.sourceAgentFolder,
        ));
      if (allowed) {
        await resolveDurableQuestionInteractionByRequestId({
          requestId: parsed.requestId,
          questionIndex: parsed.questionIndex,
          optionIndex: parsed.optionIndex >= 0 ? parsed.optionIndex : undefined,
          finalize:
            parsed.optionIndex < 0 ||
            durable?.request?.questions[parsed.questionIndex]?.multiSelect !==
              true,
          answeredBy: user?.id,
        });
      }
      return;
    }
    const allowed = await this.isInteractionApproverAllowed(
      interaction,
      user?.id,
      pending.request.sourceAgentFolder,
    );
    const question = pending.request.questions[parsed.questionIndex];
    const option =
      parsed.optionIndex >= 0
        ? question?.options[parsed.optionIndex]
        : undefined;
    if (!allowed || !question || (parsed.optionIndex >= 0 && !option)) {
      return;
    }
    if (question.multiSelect) {
      const selected = new Set(
        Array.isArray(pending.answers[question.question])
          ? (pending.answers[question.question] as string[])
          : [],
      );
      if (parsed.optionIndex < 0) {
        pending.answers[question.question] = [...selected];
        pending.finalizedQuestions.add(parsed.questionIndex);
      } else if (option) {
        if (selected.has(option.label)) {
          selected.delete(option.label);
        } else {
          selected.add(option.label);
        }
        pending.answers[question.question] = [...selected];
        return;
      }
    } else if (option) {
      pending.answers[question.question] = option.label;
      pending.finalizedQuestions.add(parsed.questionIndex);
    }
    if (pending.finalizedQuestions.size < pending.request.questions.length) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingQuestions.delete(parsed.requestId);
    pending.resolve({
      requestId: parsed.requestId,
      answers: pending.answers,
      answeredBy: user?.id,
    });
  }

  private async isInteractionApproverAllowed(
    interaction: DiscordInteraction,
    userId: string | undefined,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] = 'same_channel',
  ): Promise<boolean> {
    if (!userId || !this.opts.isControlApproverAllowed) return false;
    return this.opts.isControlApproverAllowed({
      providerId: 'discord',
      conversationJid: `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
      userId,
      sourceAgentFolder,
      decisionPolicy,
    });
  }

  private async ackInteraction(
    interaction: DiscordInteraction,
    content: string,
  ): Promise<void> {
    await fetch(
      `${DISCORD_API_ROOT}/interactions/${encodeURIComponent(interaction.id || '')}/${encodeURIComponent(interaction.token || '')}/callback`,
      {
        method: 'POST',
        headers: discordHeaders(this.botToken),
        body: JSON.stringify({
          type: 4,
          data: {
            content,
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        }),
      },
    );
  }

  private async deferEphemeralInteraction(
    interaction: DiscordInteraction,
  ): Promise<void> {
    await fetch(
      `${DISCORD_API_ROOT}/interactions/${encodeURIComponent(interaction.id || '')}/${encodeURIComponent(interaction.token || '')}/callback`,
      {
        method: 'POST',
        headers: discordHeaders(this.botToken),
        body: JSON.stringify({
          type: 5,
          data: {
            flags: 64,
          },
        }),
      },
    );
  }

  private async postDiscordInteractionFollowupFile(
    interaction: DiscordInteraction,
    fullView: PermissionPromptFullView,
  ): Promise<void> {
    // ponytail: file follow-up only for payloads too large for a single
    // ephemeral message; add chunked files only if Discord rejects real payloads.
    const form = new FormData();
    form.set(
      'payload_json',
      JSON.stringify({
        content: fullView.title,
        flags: 64,
        allowed_mentions: { parse: [] },
        attachments: [
          {
            id: 0,
            filename: fullView.filename,
            description: fullView.title,
          },
        ],
      }),
    );
    form.set(
      'files[0]',
      new Blob([fullView.content], { type: 'text/plain' }),
      fullView.filename,
    );
    await fetch(
      `${DISCORD_API_ROOT}/webhooks/${encodeURIComponent(this.applicationId)}/${encodeURIComponent(interaction.token || '')}`,
      {
        method: 'POST',
        body: form,
      },
    );
  }

  private clearPendingInteractions(): void {
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({
        approved: false,
        mode: 'cancel',
        reason: 'channel disconnected',
      });
    }
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ requestId: pending.request.requestId, answers: {} });
    }
    this.pendingPermissions.clear();
    this.pendingQuestions.clear();
  }
}

export async function createDiscordChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter | null> {
  const settings = opts.runtimeSettings?.();
  const botToken = await getProviderRuntimeSecret({
    providerId: 'discord',
    key: 'bot_token',
    defaultEnvName: 'DISCORD_BOT_TOKEN',
    settings,
    secrets: opts.runtimeSecrets,
  });
  const applicationId = await getProviderRuntimeSecret({
    providerId: 'discord',
    key: 'application_id',
    defaultEnvName: 'DISCORD_APPLICATION_ID',
    settings,
    secrets: opts.runtimeSecrets,
  });
  if (!botToken || !applicationId) {
    logger.warn(
      'Discord: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required',
    );
    return null;
  }
  return new DiscordChannel(botToken, applicationId, opts);
}
