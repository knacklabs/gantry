import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  findDurablePermissionInteractionByRequestId,
  findDurableQuestionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionInteractionByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import {
  decisionForMode,
  formatPermissionPromptText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from './permission-interaction.js';
import { ChannelAdapter, ChannelOpts } from './channel-provider.js';
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
} from './discord-components.js';
import {
  postDiscordMessageParts,
  splitDiscordText,
} from './discord-delivery.js';
import { sendDiscordProgressUpdate } from './discord-progress.js';
import { DiscordGatewayConnection } from './discord-gateway.js';
import type {
  DiscordInteraction,
  DiscordInteractionOption,
  DiscordMessageCreate,
  DiscordUser,
  WebSocketFactory,
  WebSocketLike,
} from './discord-types.js';

export const DISCORD_JID_PREFIX = 'dc:';

const DISCORD_API_ROOT = 'https://discord.com/api/v10';
const DISCORD_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

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

function websocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  private gateway: DiscordGatewayConnection | null = null;
  private botUserId = '';
  private activeProgressMessages = new Map<string, string>();
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

  constructor(
    private readonly botToken: string,
    _applicationId: string,
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
      post: (target, body) => this.postMessage(target, body),
    });
  }

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<void> {
    const channelId = options.threadId || discordChannelIdFromJid(jid);
    if (!channelId) return;
    await sendDiscordProgressUpdate({
      key: `${jid}\n${options.threadId ?? ''}\n${options.generation ?? ''}`,
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

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    const modes = permissionDecisionOptions(request);
    await this.sendDiscordPrompt(
      jid,
      formatPermissionPromptText(request, DISCORD_INTERACTION_TIMEOUT_MS),
      {
        threadId: request.threadId,
        components: buttonRows(
          modes.map((mode) => ({
            label: permissionButtonLabel(mode, request),
            style: mode === 'cancel' ? 4 : 1,
            custom_id: permissionCustomId(request.requestId, mode),
          })),
        ),
      },
    );
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

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${DISCORD_API_ROOT}${path}`, {
      method: 'POST',
      headers: discordHeaders(this.botToken),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Discord REST request failed: ${path}`);
    return (await response.json()) as T;
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
    const response = await fetch(
      `${DISCORD_API_ROOT}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: discordHeaders(this.botToken),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error('Discord message edit failed');
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
    await this.opts.onChatMetadata(
      `${DISCORD_JID_PREFIX}${message.channel_id}`,
      message.timestamp || new Date().toISOString(),
      undefined,
      'discord',
      true,
    );
    await this.opts.onMessage(`${DISCORD_JID_PREFIX}${message.channel_id}`, {
      id: message.id,
      chat_jid: `${DISCORD_JID_PREFIX}${message.channel_id}`,
      provider: 'discord',
      sender: author?.id || 'unknown',
      sender_name: message.member?.nick || userName(author),
      content: message.content || '',
      timestamp: message.timestamp || new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      external_message_id: message.id,
      reply_to_message_id: message.referenced_message?.id,
      reply_to_message_content: message.referenced_message?.content,
      reply_to_sender_name: userName(message.referenced_message?.author, ''),
    });
  }

  private async handleInteraction(interaction: DiscordInteraction) {
    if (!interaction.id || !interaction.token || !interaction.channel_id) {
      return;
    }
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith(LIVE_STOP_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking stop request.');
        await this.opts.onMessageAction?.({
          kind: 'live_turn_stop',
          conversationJid: `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
          userId: interaction.member?.user?.id || interaction.user?.id,
          actionToken: customId.slice(LIVE_STOP_CUSTOM_ID_PREFIX.length),
        });
        return;
      }
      if (customId.startsWith(PERMISSION_CUSTOM_ID_PREFIX)) {
        await this.handlePermissionInteraction(interaction, customId);
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
    await this.opts.onMessage(
      `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
      {
        id: interaction.id,
        chat_jid: `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
        provider: 'discord',
        sender: user?.id || 'unknown',
        sender_name: interaction.member?.nick || userName(user),
        content: commandText,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
        external_message_id: interaction.id,
      },
    );
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
    await this.ackInteraction(interaction, 'Working on it.');
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
    await this.ackInteraction(interaction, 'Working on it.');
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
  const botToken = opts.runtimeSecrets?.getOptionalSecret({
    env: 'DISCORD_BOT_TOKEN',
  });
  const applicationId = opts.runtimeSecrets?.getOptionalSecret({
    env: 'DISCORD_APPLICATION_ID',
  });
  if (!botToken || !applicationId) {
    logger.warn(
      'Discord: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required',
    );
    return null;
  }
  return new DiscordChannel(botToken, applicationId, opts);
}
