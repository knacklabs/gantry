// prettier-ignore
import { dispatchDiscordSchedulerInteraction } from './scheduler-interactions.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalResult,
  RichInteractionRequest,
  UserQuestionCancellation,
  UserQuestionRequest,
} from '../../domain/types.js';
import {
  claimPermissionInteractionCallback,
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
  releasePermissionInteractionCallback,
  resolveDurableQuestionInteractionByRequestId,
} from '../../application/interactions/pending-interaction-durability.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../shared/permission-timeout.js';
import { resolveInteractionSettlementDelayMs } from '../interaction-settlement.js';
// prettier-ignore
import { deliveryNotSent, deliveryUnknown } from '../permission-approval-result.js';
import { cancelPendingDiscordPermission } from './permission-cancellation.js';
import { cancelPendingDiscordQuestion } from './question-cancellation.js';
import {
  buildPermissionPromptParts,
  decisionForMode,
  formatPermissionPromptPartsText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import { type ChannelOpts } from '../channel-provider.js';
import {
  buttonRows,
  LIVE_STOP_CUSTOM_ID_PREFIX,
  parseQuestionCustomId,
  PERMISSION_CUSTOM_ID_PREFIX,
  permissionCustomId,
  QUESTION_CUSTOM_ID_PREFIX,
} from './components.js';
import { sendDiscordPromptMessage } from './delivery.js';
import type { DiscordInteraction } from './types.js';
import { RICH_INTERACTION_SUBMITTED_BY_COPY } from '../rich-interaction.js';
import {
  DISCORD_RICH_FORM_OPEN_PREFIX,
  openDiscordRichFormInteraction,
  renderDiscordRichInteraction,
} from './rich-interaction.js';
import {
  ackDiscordInteraction,
  DISCORD_API_ROOT,
  discordChannelIdFromJid,
  discordGantrySlashText,
  discordHeaders,
  discordUserName,
  updateDiscordInteractionResponse,
} from './interaction-helpers.js';
import { bindDiscordPermissionPrompt } from './prompt-binding.js';
import * as permissionPrompt from './permission-prompt-settlement.js';
import { handleDiscordPermissionCallback } from './permission-callback.js';
import {
  DISCORD_PERMISSION_FULL_VIEW_PREFIX,
  discordPermissionFullViewCustomId,
  handleDiscordPermissionFullView,
} from './permission-full-view.js';
import {
  createDiscordUserQuestionRequester,
  dropPendingDiscordQuestions,
  resolvePendingDiscordQuestionsOnDisconnect,
  type PendingDiscordQuestion,
} from './user-question-delivery.js';
import { createDiscordPermissionCardPreparer } from './prepared-permission-card.js';
import {
  isDiscordInteractionApproverAllowed,
  type DiscordConversationContext,
} from './extracted-helpers.js';
const DISCORD_RICH_FORM_SUBMIT_PREFIX = 'gantry:rich_form_submit:';
type PendingPermission = ReturnType<typeof permissionPrompt.pending>;
export class DiscordInteractionHandler {
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingDiscordQuestion>();
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
  dropPendingInteraction(
    kind: 'permission' | 'question',
    request: PermissionApprovalRequest | UserQuestionRequest,
  ): void {
    if (kind === 'permission')
      permissionPrompt.drop(this.pendingPermissions, request);
    else dropPendingDiscordQuestions(this.pendingQuestions, request);
  }
  async cancelPendingPermission(
    cancellation: PermissionApprovalCancellation,
  ): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'> {
    return cancelPendingDiscordPermission(
      this.pendingPermissions,
      cancellation,
      (providerAlias, reason) =>
        this.settlePermissionPrompt(providerAlias, 'cancel', 'runtime', reason),
    );
  }
  cancelPendingQuestion(cancellation: UserQuestionCancellation) {
    return cancelPendingDiscordQuestion(
      this.pendingQuestions,
      this.input.botToken,
      cancellation,
    );
  }
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
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalResult> {
    const callback = {
      providerAlias: globalThis.crypto.randomUUID(),
      scope: {
        appId: request.appId || 'default',
        sourceAgentFolder: request.sourceAgentFolder,
        interactionId: request.requestId,
      },
      matchKind: request.permissionBatch
        ? ('batch' as const)
        : ('individual' as const),
    };
    const modes = permissionDecisionOptions(request);
    const parts = buildPermissionPromptParts(
      request,
      PERMISSION_APPROVAL_TIMEOUT_MS,
    );
    const buttons = [
      ...(parts.fullView
        ? [
            {
              label: parts.fullView.label,
              style: 2,
              custom_id: discordPermissionFullViewCustomId(
                callback.providerAlias,
              ),
            },
          ]
        : []),
      ...modes.map((mode) => ({
        label: permissionButtonLabel(mode, request),
        style: mode === 'cancel' ? 4 : 1,
        custom_id: permissionCustomId(callback.providerAlias, mode),
      })),
    ];
    // A Discord thread ID is itself a channel ID for message-create.
    if (!(request.threadId || discordChannelIdFromJid(jid)))
      return deliveryNotSent(
        'target_missing',
        'This Discord conversation could not be identified.',
      );
    // Bind against the channel the message is actually SENT to (threads
    // are channels; callback recovery matches this id - review R9).
    const conversationId =
      request.threadId || discordChannelIdFromJid(jid) || jid;
    if (
      !(await bindDiscordPermissionPrompt(
        request,
        conversationId,
        callback.providerAlias,
      ))
    ) {
      return deliveryNotSent(
        'provider_failed',
        'Discord permission callback binding failed',
      );
    }
    let sent: MessageDeliveryResult;
    try {
      sent = await this.sendDiscordPrompt(
        jid,
        formatPermissionPromptPartsText(parts),
        {
          threadId: request.threadId,
          components: buttonRows(buttons),
        },
      );
    } catch (err) {
      if (err instanceof DurableInteractionPersistenceError) throw err;
      return deliveryUnknown('Failed to send approval prompt to Discord');
    }
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const decision = new Promise<PermissionApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const { expiresAt } = request as PermissionApprovalRequest & {
      expiresAt?: unknown;
    };
    const settlementDelayMs = resolveInteractionSettlementDelayMs({
      expiresAt,
      isPermissionRequest: true,
      jobId: request.jobId,
      permissionLane: request.permissionLane,
      fallbackTimeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
    });
    let timeout!: ReturnType<typeof setTimeout>;
    if (settlementDelayMs !== undefined) {
      timeout = setTimeout(() => {
        void this.timeoutPermissionPrompt(
          callback.providerAlias,
          settlementDelayMs,
        );
      }, settlementDelayMs);
      timeout.unref?.();
    }
    const livePending = permissionPrompt.pending(
      callback,
      request,
      sent,
      request.threadId || conversationId,
      resolveDecision,
      timeout,
    );
    this.pendingPermissions.set(callback.providerAlias, livePending);
    if (sent.externalMessageId) {
      try {
        const bound = await bindDiscordPermissionPrompt(
          request,
          conversationId,
          callback.providerAlias,
          sent.externalMessageIds?.at(-1) ?? sent.externalMessageId,
          parts.fullView,
        );
        if (!bound)
          throw new Error('Discord permission message binding failed');
      } catch (err) {
        // Post-send persistence = delivered:'unknown' (0128, R7): the
        // card may be live; never retry into a duplicate.
        clearTimeout(timeout);
        if (this.pendingPermissions.get(callback.providerAlias) === livePending)
          this.pendingPermissions.delete(callback.providerAlias);
        return deliveryUnknown('Failed to bind Discord approval prompt');
      }
    } else {
      clearTimeout(timeout);
      if (this.pendingPermissions.get(callback.providerAlias) === livePending)
        this.pendingPermissions.delete(callback.providerAlias);
      return deliveryUnknown('Discord permission message id missing');
    }
    if (sent.externalMessageId) onPromptDelivered?.(sent.externalMessageId);
    return { kind: 'decision', decision: await decision };
  }
  // prettier-ignore
  preparePermissionCardSend(...args: Parameters<ReturnType<typeof createDiscordPermissionCardPreparer>>) {
    return createDiscordPermissionCardPreparer((channelId, body) => this.input.postMessage(channelId, body))(...args);
  }
  requestUserAnswer = createDiscordUserQuestionRequester({
    pendingQuestions: this.pendingQuestions,
    sendPrompt: (jid, text, options) =>
      this.sendDiscordPrompt(jid, text, options),
    timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
  });
  async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.id || !interaction.token || !interaction.channel_id)
      return;
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id || '';
      const userId = interaction.member?.user?.id || interaction.user?.id;
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
          userId,
          actionToken: customId.slice(LIVE_STOP_CUSTOM_ID_PREFIX.length),
        });
        return;
      }
      if (customId.startsWith('jp:')) {
        const context = await this.input.resolveInteractionConversationContext(
          interaction.channel_id,
        );
        await this.input.opts.onMessageAction?.({
          kind: 'job_permission_decision',
          conversationJid: context.conversationJid,
          providerAccountId: this.input.opts.providerAccountId,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          userId,
          ...(interaction.message?.id
            ? { messageId: interaction.message.id }
            : {}),
          actionToken: customId,
        });
        await this.ackInteraction(interaction, 'Decision received.');
        return;
      }
      const handledScheduler = await dispatchDiscordSchedulerInteraction(
        customId,
        userId,
        interaction.channel_id,
        this.input,
        (text) => this.ackInteraction(interaction, text),
      );
      if (handledScheduler) return;
      if (customId.startsWith(PERMISSION_CUSTOM_ID_PREFIX)) {
        await this.handlePermissionInteraction(interaction, customId);
        return;
      }
      if (customId.startsWith(DISCORD_PERMISSION_FULL_VIEW_PREFIX)) {
        await handleDiscordPermissionFullView({
          interaction,
          customId,
          appId: this.input.opts.appId || 'default',
          applicationId: this.input.applicationId,
          botToken: this.input.botToken,
          timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
          pendingPermissions: this.pendingPermissions,
          resolveConversationContext: (channelId) =>
            this.input.resolveInteractionConversationContext(channelId),
          isApproverAllowed: (
            userId,
            sourceAgentFolder,
            decisionPolicy,
            threadId,
            conversationJid,
          ) =>
            isDiscordInteractionApproverAllowed(
              this.input.opts,
              interaction,
              userId,
              sourceAgentFolder,
              decisionPolicy,
              threadId,
              conversationJid,
            ),
          acknowledge: (content) => this.ackInteraction(interaction, content),
        });
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
          `${RICH_INTERACTION_SUBMITTED_BY_COPY} ${discordUserName(user)}.`,
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
      sender_name: interaction.member?.nick || discordUserName(user),
      content: commandText,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      thread_id: context.threadId,
      external_message_id: interaction.id,
    });
  }

  async clearPendingInteractions(): Promise<void> {
    for (const providerAlias of this.pendingPermissions.keys()) {
      const result = await this.settlePermissionPrompt(
        providerAlias,
        'cancel',
        'system',
        'channel disconnected',
      );
      if (result === 'already_decided') continue;
      const pending = this.pendingPermissions.get(providerAlias);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pendingPermissions.delete(providerAlias);
      pending.resolve({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'channel disconnected',
      });
    }
    resolvePendingDiscordQuestionsOnDisconnect(this.pendingQuestions);
  }

  private async settlePermissionPrompt(
    providerAlias: string,
    mode: PermissionApprovalDecisionMode,
    approverRef: string,
    reason: string,
  ): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'> {
    const pending = this.pendingPermissions.get(providerAlias);
    if (!pending) return 'already_decided';
    const claimed = await claimPermissionInteractionCallback({
      scope: pending.callback.scope,
      mode,
      approverRef,
      matchKind: pending.callback.matchKind,
      providerAlias,
    });
    if (claimed.status === 'already_decided')
      return claimed.ownerless ? 'ownerless' : 'already_decided';
    if (claimed.status === 'retryable') return 'retryable';
    const decision = {
      ...decisionForMode(pending.request, mode, approverRef),
      reason,
      permissionCallbackClaim: claimed.claim,
    };
    if (
      !(await permissionPrompt.settle(
        this.pendingPermissions,
        providerAlias,
        decision,
        this.input,
      ))
    ) {
      await releasePermissionInteractionCallback({ claim: claimed.claim });
      return 'retryable';
    }
    return 'settled';
  }

  private async timeoutPermissionPrompt(
    providerAlias: string,
    retryWindowMs: number,
  ): Promise<void> {
    let result = await this.settlePermissionPrompt(
      providerAlias,
      'cancel',
      'system',
      'timed out',
    );
    if (result === 'settled') return;
    if (result === 'already_decided') return;
    if (result === 'retryable') {
      for (const delayMs of permissionPrompt.timeoutRetryDelays(
        retryWindowMs,
      )) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
        if (!this.pendingPermissions.has(providerAlias)) return;
        result = await this.settlePermissionPrompt(
          providerAlias,
          'cancel',
          'system',
          'timed out',
        );
        if (result !== 'retryable') break;
      }
    }
    if (result === 'already_decided') return;
    const pending = this.pendingPermissions.get(providerAlias);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(providerAlias);
    pending.resolve({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
  }

  private async sendDiscordPrompt(
    jid: string,
    text: string,
    options: { threadId?: string; components?: unknown[] } = {},
  ): Promise<MessageDeliveryResult> {
    return sendDiscordPromptMessage(
      (target, body) => this.input.postMessage(target, body),
      jid,
      text,
      options,
    );
  }

  private async handlePermissionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    await handleDiscordPermissionCallback({
      appId: this.input.opts.appId || 'default',
      interaction,
      customId,
      pendingPermissions: this.pendingPermissions,
      botToken: this.input.botToken,
      ack: (content) => this.ackInteraction(interaction, content),
      feedback: (content) =>
        updateDiscordInteractionResponse(
          this.input.applicationId,
          interaction,
          content,
        ),
      resolveConversationContext: (channelId) =>
        this.input.resolveInteractionConversationContext(channelId),
      isApproverAllowed: (userId, folder, policy, threadId, conversationJid) =>
        isDiscordInteractionApproverAllowed(
          this.input.opts,
          interaction,
          userId,
          folder,
          policy,
          threadId,
          conversationJid,
        ),
    });
  }

  private async handleQuestionInteraction(
    interaction: DiscordInteraction,
    customId: string,
  ): Promise<void> {
    const parsed = parseQuestionCustomId(customId);
    const pending = parsed
      ? this.pendingQuestions.get(parsed.providerAlias)
      : undefined;
    if (!parsed) {
      await this.ackInteraction(
        interaction,
        'This question is no longer active.',
      );
      return;
    }
    const deferAcknowledgement = Boolean(
      pending &&
      parsed.optionIndex >= 0 &&
      pending.callbacks.some(
        (callback) =>
          callback.providerAlias === parsed.providerAlias &&
          pending.request.questions[callback.questionIndex]?.multiSelect,
      ),
    );
    if (!deferAcknowledgement) {
      await this.ackInteraction(interaction, 'Processing.');
    }
    const user = interaction.member?.user || interaction.user;
    if (!pending) return;
    const allowed = await isDiscordInteractionApproverAllowed(
      this.input.opts,
      interaction,
      user?.id,
      pending.request.sourceAgentFolder,
    );
    const callback = pending.callbacks.find(
      (candidate) => candidate.providerAlias === parsed.providerAlias,
    );
    if (!callback) return;
    const questionIndex = callback.questionIndex;
    const question = pending.request.questions[questionIndex];
    const option =
      parsed.optionIndex >= 0
        ? question?.options[parsed.optionIndex]
        : undefined;
    if (!allowed || !question || (parsed.optionIndex >= 0 && !option)) {
      if (deferAcknowledgement) {
        await this.ackInteraction(
          interaction,
          'This question is no longer active.',
        );
      }
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
        pending.finalizedQuestions.add(questionIndex);
      } else if (option) {
        const recorded = await resolveDurableQuestionInteractionByRequestId({
          requestId: pending.request.requestId,
          appId: pending.request.appId,
          sourceAgentFolder: pending.request.sourceAgentFolder,
          questionIndex,
          optionIndex: parsed.optionIndex,
          finalize: false,
        });
        if (!recorded) {
          throw new DurableInteractionPersistenceError(
            'Discord user question selection was not persisted',
          );
        }
        if (selected.has(option.label)) {
          selected.delete(option.label);
        } else {
          selected.add(option.label);
        }
        pending.answers[question.question] = [...selected];
        await this.ackInteraction(interaction, 'Processing.');
        return;
      }
    } else if (option) {
      pending.answers[question.question] = option.label;
      pending.finalizedQuestions.add(questionIndex);
    }
    if (pending.finalizedQuestions.has(questionIndex)) {
      const recorded = await recordDurableQuestionAnswerProgress({
        requestId: pending.request.requestId,
        appId: pending.request.appId,
        sourceAgentFolder: pending.request.sourceAgentFolder,
        answers: {
          [question.question]: pending.answers[question.question]!,
        },
      });
      if (!recorded) return;
    }
    if (pending.finalizedQuestions.size < pending.request.questions.length) {
      return;
    }
    clearTimeout(pending.timeout);
    for (const questionCallback of pending.callbacks) {
      this.pendingQuestions.delete(questionCallback.providerAlias);
    }
    pending.resolve({
      requestId: pending.request.requestId,
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
  private async ackInteraction(
    interaction: DiscordInteraction,
    content: string,
  ): Promise<void> {
    await ackDiscordInteraction(this.input.botToken, interaction, content);
  }
}
