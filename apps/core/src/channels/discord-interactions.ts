import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  RichInteractionRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
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
import { type ChannelOpts } from './channel-provider.js';
import {
  buttonRows,
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
  postDiscordMessageParts,
  splitDiscordText,
} from './discord-delivery.js';
import type {
  DiscordInteraction,
  DiscordInteractionOption,
  DiscordUser,
} from './discord-types.js';
import { RICH_INTERACTION_SUBMITTED_BY_COPY } from './rich-interaction.js';
import {
  DISCORD_RICH_FORM_OPEN_PREFIX,
  openDiscordRichFormInteraction,
  renderDiscordRichInteraction,
} from './discord-rich-interaction.js';
import {
  DISCORD_API_ROOT,
  DISCORD_JID_PREFIX,
  discordChannelIdFromJid,
  discordHeaders,
} from './discord-interaction-helpers.js';
const DISCORD_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;
const DISCORD_PERMISSION_FULL_VIEW_PREFIX = 'gantry:perm_full:';
const DISCORD_RICH_FORM_SUBMIT_PREFIX = 'gantry:rich_form_submit:';
const DISCORD_EPHEMERAL_MESSAGE_LIMIT = 1900;
type DiscordConversationContext = {
  conversationJid: string;
  threadId?: string;
};
type PendingPermission = {
  request: PermissionApprovalRequest;
  resolve: (decision: PermissionApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
};
type PendingQuestion = {
  request: UserQuestionRequest;
  answers: Record<string, string | string[]>;
  finalizedQuestions: Set<number>;
  resolve: (response: UserQuestionResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
};
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

export class DiscordInteractionHandler {
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private readonly richForms = new Map<string, RichInteractionRequest>();

  constructor(
    private readonly input: {
      botToken: string;
      applicationId: string;
      opts: ChannelOpts;
      postMessage: (
        channelId: string,
        body: Record<string, unknown>,
      ) => Promise<{ id?: string }>;
      sendMessage: (
        jid: string,
        text: string,
        options?: MessageSendOptions,
      ) => Promise<MessageDeliveryResult>;
      resolveInteractionConversationContext: (
        channelId: string,
      ) => Promise<DiscordConversationContext>;
    },
  ) {}

  async renderRichInteraction(
    jid: string,
    render: RichInteractionRequest,
  ): Promise<boolean> {
    return renderDiscordRichInteraction({
      jid,
      channelId: render.threadId || discordChannelIdFromJid(jid),
      render,
      richForms: this.richForms,
      postMessage: (channelId, body) => this.input.postMessage(channelId, body),
      sendFallback: (text, options) =>
        this.input.sendMessage(jid, text, options),
    });
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

  async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.id || !interaction.token || !interaction.channel_id)
      return;
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith(LIVE_STOP_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking stop request.');
        const context = await this.input.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.input.opts.onMessageAction?.({
          kind: 'live_turn_stop',
          conversationJid: context.conversationJid,
          providerAccountId: this.input.opts.providerAccountId,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          userId: interaction.member?.user?.id || interaction.user?.id,
          actionToken: customId.slice(LIVE_STOP_CUSTOM_ID_PREFIX.length),
        });
        return;
      }
      if (customId.startsWith(SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX)) {
        await this.ackInteraction(interaction, 'Checking retry request.');
        const context = await this.input.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.input.opts.onMessageAction?.({
          kind: 'scheduler_run_now',
          conversationJid: context.conversationJid,
          providerAccountId: this.input.opts.providerAccountId,
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
        return;
      }
      if (customId.startsWith(DISCORD_RICH_FORM_OPEN_PREFIX)) {
        await this.openRichFormInteraction(interaction, customId);
      }
      return;
    }
    if (interaction.type === 5) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith(DISCORD_RICH_FORM_SUBMIT_PREFIX)) {
        this.richForms.delete(
          customId.slice(DISCORD_RICH_FORM_SUBMIT_PREFIX.length),
        );
        const user = interaction.member?.user || interaction.user;
        await this.ackInteraction(
          interaction,
          `${RICH_INTERACTION_SUBMITTED_BY_COPY} ${userName(user)}.`,
        );
      }
      return;
    }
    if (interaction.type !== 2 || interaction.data?.name !== 'gantry') return;
    const commandText = discordGantrySlashText(interaction);
    await this.ackInteraction(interaction, `Gantry received ${commandText}.`);
    const user = interaction.member?.user || interaction.user;
    const context = await this.input.resolveInteractionConversationContext(
      interaction.channel_id,
    );
    await this.input.opts.onMessage(context.conversationJid, {
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

  clearPendingInteractions(): void {
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
      post: (target, body) => this.input.postMessage(target, body),
    });
  }

  private async handlePermissionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
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
          durable.threadId ?? undefined,
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
      pending.request.decisionPolicy,
      pending.request.threadId,
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
        pending.request.threadId,
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
        durable.threadId ?? undefined,
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
  ): Promise<void> {
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

  private async openRichFormInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    await openDiscordRichFormInteraction({
      apiRoot: DISCORD_API_ROOT,
      headers: discordHeaders(this.input.botToken),
      interaction,
      customId,
      richForms: this.richForms,
      ackInteraction: (message) => this.ackInteraction(interaction, message),
    });
  }

  private async isInteractionApproverAllowed(
    interaction: DiscordInteraction,
    userId: string | undefined,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] = 'same_channel',
    threadId?: string,
  ): Promise<boolean> {
    if (!userId || !this.input.opts.isControlApproverAllowed) return false;
    return this.input.opts.isControlApproverAllowed({
      providerId: 'discord',
      providerAccountId: this.input.opts.providerAccountId,
      agentId: this.input.opts.agentId,
      conversationJid: `${DISCORD_JID_PREFIX}${interaction.channel_id}`,
      threadId,
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
        headers: discordHeaders(this.input.botToken),
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
        headers: discordHeaders(this.input.botToken),
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
      `${DISCORD_API_ROOT}/webhooks/${encodeURIComponent(this.input.applicationId)}/${encodeURIComponent(interaction.token || '')}`,
      {
        method: 'POST',
        body: form,
      },
    );
  }
}
