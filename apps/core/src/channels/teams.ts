import {
  CHANNEL_STREAM_UPDATE_INTERVAL_MS,
  type ChannelAdapter,
  type ChannelOpts,
  type ConversationContextHydrationRequest,
} from './channel-provider.js';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
  NewMessage,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import {
  findDurablePermissionInteractionByRequestId,
  findDurableQuestionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionAnswersByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import { logger } from '../infrastructure/logging/logger.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import {
  decisionForMode,
  formatPermissionReceiptText,
  normalizePermissionAction,
  permissionDecisionOptions,
} from './permission-interaction.js';
import {
  TEAMS_HARD_MESSAGE_BYTES,
  sendTeamsTextMessage,
  splitTeamsTextByByteBudget,
} from './teams-delivery.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { readTeamsPermissionDecision } from './teams-permission-submit.js';
import {
  buildTeamsApprovalAdaptiveCard,
  buildTeamsMessageCard,
  buildTeamsUserQuestionCard,
  buildTeamsUserQuestionReceiptCard,
  formatTeamsAttachmentUnavailableCopy as teamsTextWithAttachmentNotice,
} from './teams-cards.js';
import { handleTeamsMessageAction } from './teams-message-actions.js';
import {
  sendTeamsProgressUpdate,
  sendTeamsTextOrActionMessage,
  type TeamsProgressMessages,
} from './teams-progress.js';
import { bindTeamsPermissionPromptMessage } from './teams-prompt-binding.js';
import { renderTeamsAgentTodo, type TeamsTodoMessages } from './teams-todos.js';
import {
  formatTeamsUserQuestionReceipt,
  mapTeamsUserQuestionAnswers,
  readTeamsUserQuestionSubmit,
  type TeamsUserQuestionSubmit,
} from './teams-user-question.js';
import {
  isTeamsJid,
  normalizeTeamsJid,
  readTeamsCredentials,
  teamsConversationIdFromJid,
  type PendingTeamsPermissionPrompt,
  type PendingTeamsUserQuestion,
  type TeamsChannelCredentials,
  type TeamsChannelDependencies,
  type TeamsChannelOpts,
  type TeamsInboundMessage,
  type TeamsSdkClient,
} from './teams-types.js';
import {
  hydrateTeamsConversationContext,
  teamsMessageAttachments as teamsInboundMessageAttachments,
} from './teams-conversation-context.js';

interface TeamsStreamingState {
  conversationId: string;
  messageId?: string;
  rawBuffer: string;
  lastFlushAt: number;
  pendingDelivery: Promise<boolean>;
}

export {
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  buildTeamsAgentTodoCard,
  buildTeamsApprovalAdaptiveCard,
  buildTeamsApprovalDescriptorPayload,
  buildTeamsUserQuestionCard,
  buildTeamsUserQuestionReceiptCard,
  type TeamsAdaptiveCardAction,
  type TeamsAdaptiveCardDescriptorPayload,
  type TeamsAdaptiveCardPayload,
  type TeamsAdaptiveCardSubmitAction,
} from './teams-cards.js';
export {
  TEAMS_JID_PREFIX,
  isTeamsJid,
  normalizeTeamsJid,
  teamsConversationIdFromJid,
  type TeamsChannelCredentials,
  type TeamsChannelDependencies,
  type TeamsInboundMessage,
  type TeamsSdkClient,
} from './teams-types.js';

export class TeamsChannel implements ChannelAdapter {
  name = 'teams';

  private connected = false;
  private outboundReady = false;
  private readonly pendingPermissionPrompts = new Map<
    string,
    PendingTeamsPermissionPrompt
  >();
  private readonly pendingTodos: TeamsTodoMessages = new Map();
  private readonly pendingProgress: TeamsProgressMessages = new Map();
  private readonly activeStreams = new Map<string, TeamsStreamingState>();
  private readonly streamGenerationByJid = new Map<string, number>();
  private readonly sealedStreamGenerationByJid = new Map<string, number>();
  private readonly pendingUserQuestions = new Map<
    string,
    PendingTeamsUserQuestion
  >();

  constructor(
    private readonly credentials: TeamsChannelCredentials,
    private readonly opts: TeamsChannelOpts,
    private readonly sdkClient: TeamsSdkClient,
  ) {}

  async connect(
    options: { inbound?: boolean; interactionCallbacks?: boolean } = {},
  ): Promise<void> {
    if (this.connected || this.outboundReady) return;
    const inboundEnabled = options.inbound !== false;
    const interactionCallbacksEnabled =
      options.interactionCallbacks ?? inboundEnabled;
    await this.sdkClient.start({
      credentials: this.credentials,
      onMessage: async (message) => {
        if (inboundEnabled) {
          await this.ingestMessage(message);
          return;
        }
        if (!interactionCallbacksEnabled) return;
        const jid = normalizeTeamsJid(message.conversationId);
        if (!jid) return;
        const sender = message.senderId || message.from?.id || 'unknown';
        const senderName = message.senderName || message.from?.name || sender;
        const handledPermission = await this.handlePermissionDecision(
          message,
          jid,
          sender,
          senderName,
        );
        const handledAction =
          !handledPermission &&
          (await this.handleMessageAction(message, jid, sender));
        if (!handledPermission && !handledAction) {
          await this.handleUserQuestionSubmit(message, jid, sender, senderName);
        }
      },
    });
    this.connected = true;
    this.outboundReady = true;
    if (!inboundEnabled && !interactionCallbacksEnabled) {
      logger.info('Teams outbound delivery client initialized');
    }
  }

  isConnected(): boolean {
    return this.connected || this.outboundReady;
  }

  async disconnect(): Promise<void> {
    if (!this.connected && !this.outboundReady) return;
    if (this.connected) {
      await this.sdkClient.stop();
    }
    for (const requestId of this.pendingPermissionPrompts.keys()) {
      await this.resolvePermissionPrompt(requestId, {
        approved: false,
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      });
    }
    for (const requestId of this.pendingUserQuestions.keys()) {
      await this.resolvePendingUserQuestion(requestId, {
        requestId,
        answers: {},
        answeredBy: 'system',
      });
    }
    this.connected = false;
    this.outboundReady = false;
  }

  ownsJid(jid: string): boolean {
    return isTeamsJid(jid);
  }

  async hydrateConversationContext(
    request: ConversationContextHydrationRequest,
  ) {
    return hydrateTeamsConversationContext(
      request,
      this.sdkClient,
      this.credentials.clientId,
    );
  }

  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<MessageDeliveryResult | void> {
    if (!this.outboundReady) return;
    return sendTeamsTextOrActionMessage({
      sdkClient: this.sdkClient,
      jid,
      text: teamsTextWithAttachmentNotice(text, Boolean(options.files?.length)),
      options,
    });
  }

  async addReaction(): Promise<void> {}

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<void> {
    if (!this.outboundReady) return;
    await sendTeamsProgressUpdate({
      sdkClient: this.sdkClient,
      pendingProgress: this.pendingProgress,
      jid,
      text,
      options,
    });
  }

  async sendStreamingChunk(
    jid: string,
    text: string,
    options: StreamingChunkOptions = {},
  ): Promise<boolean> {
    if (!this.outboundReady) return false;
    if (!this.shouldAcceptStreamingChunk(jid, options.generation)) return false;
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId) return false;

    const key = this.streamKey(jid, options.threadId);
    let state = this.activeStreams.get(key);
    if (!state) {
      state = {
        conversationId,
        rawBuffer: '',
        lastFlushAt: 0,
        pendingDelivery: Promise.resolve(false),
      };
      this.activeStreams.set(key, state);
    }

    const run = () =>
      this.applyTeamsStreamingChunk({ jid, key, state, text, options });
    state.pendingDelivery = state.pendingDelivery.then(run, run);
    return state.pendingDelivery;
  }

  resetStreaming(jid: string): void {
    this.clearStreamingStateForJid(jid);
    this.sealStreamingGenerationOnReset(jid);
  }

  async renderAgentTodo(
    jid: string,
    render: AgentTodoRender,
  ): Promise<boolean> {
    if (!this.outboundReady) return false;
    return renderTeamsAgentTodo({
      sdkClient: this.sdkClient,
      pendingTodos: this.pendingTodos,
      jid,
      render,
    });
  }

  private streamKey(jid: string, threadId?: string): string {
    return `${jid}\n${threadId ?? ''}`;
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

  private async applyTeamsStreamingChunk(input: {
    jid: string;
    key: string;
    state: TeamsStreamingState;
    text: string;
    options: StreamingChunkOptions;
  }): Promise<boolean> {
    const current = this.activeStreams.get(input.key);
    if (current !== input.state) return false;
    if (input.text) input.state.rawBuffer += input.text;
    if (!input.state.rawBuffer.trim() && input.options.done) {
      this.activeStreams.delete(input.key);
      this.markStreamingGenerationDone(input.jid, input.options.generation);
      return false;
    }

    const now = currentTimeMs();
    const shouldFlush =
      input.options.done ||
      !input.state.messageId ||
      now - input.state.lastFlushAt >= CHANNEL_STREAM_UPDATE_INTERVAL_MS.teams;
    if (!shouldFlush) return Boolean(input.state.messageId);

    const delivered = await this.flushTeamsStreamingState(input);
    input.state.lastFlushAt = now;
    if (input.options.done) {
      this.activeStreams.delete(input.key);
      this.markStreamingGenerationDone(input.jid, input.options.generation);
    }
    return delivered;
  }

  private async flushTeamsStreamingState(input: {
    jid: string;
    state: TeamsStreamingState;
    options: StreamingChunkOptions;
  }): Promise<boolean> {
    const options = input.options;
    const parts = splitTeamsTextByByteBudget(
      input.state.rawBuffer,
      TEAMS_HARD_MESSAGE_BYTES,
    );
    const headText = parts[0] ?? ' ';
    const hasNativeStreaming =
      this.sdkClient.sendAdaptiveCard && this.sdkClient.updateAdaptiveCard;
    if (!hasNativeStreaming) {
      if (!options.done) return false;
      await sendTeamsTextMessage(
        this.sdkClient,
        input.state.conversationId,
        input.state.rawBuffer,
        options,
      );
      return true;
    }

    const card = buildTeamsMessageCard({
      text: headText || ' ',
      targetJid: input.jid,
      threadId: options.threadId,
    });
    if (input.state.messageId) {
      await this.sdkClient.updateAdaptiveCard?.({
        conversationId: input.state.conversationId,
        messageId: input.state.messageId,
        card,
        streamType: 'streaming',
        ...(options.threadId ? { threadId: options.threadId } : {}),
      });
    } else {
      const sent = await this.sdkClient.sendAdaptiveCard?.({
        conversationId: input.state.conversationId,
        card,
        streamType: 'informative',
        ...(options.threadId ? { threadId: options.threadId } : {}),
      });
      input.state.messageId = sent?.externalMessageId;
    }

    if (options.done && parts.length > 1) {
      // ponytail: cap overflow at Teams' provider limit; do not add rolling
      // chunk messages during normal streaming cadence.
      await sendTeamsTextMessage(
        this.sdkClient,
        input.state.conversationId,
        parts.slice(1).join(''),
        options,
      );
    }
    return true;
  }

  async ingestMessage(message: TeamsInboundMessage): Promise<void> {
    const jid = normalizeTeamsJid(message.conversationId);
    if (!jid) return;

    const timestamp = message.timestamp || nowIso();
    const sender = message.senderId || message.from?.id || 'unknown';
    const senderName = message.senderName || message.from?.name || sender;
    if (await this.handlePermissionDecision(message, jid, sender, senderName)) {
      return;
    }
    if (await this.handleMessageAction(message, jid, sender)) {
      return;
    }
    if (await this.handleUserQuestionSubmit(message, jid, sender, senderName)) {
      return;
    }

    const content = message.text?.trim() || '';
    const attachments = teamsInboundMessageAttachments(message);
    if (!content && attachments.length === 0) return;

    await this.opts.onChatMetadata(
      jid,
      timestamp,
      message.conversationName,
      'teams',
      message.conversationType !== 'personal',
    );

    const normalized: NewMessage = {
      id: message.id || `teams:${message.conversationId}:${timestamp}`,
      chat_jid: jid,
      provider: 'teams',
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id: message.threadId,
      reply_to_message_id: message.replyToId,
      external_message_id: message.id,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    await this.opts.onMessage(jid, normalized);
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    if (!this.connected) {
      return { approved: false, reason: 'Teams channel is not connected' };
    }
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId) {
      return {
        approved: false,
        reason: 'This Teams conversation could not be identified.',
      };
    }
    if (!this.sdkClient.sendAdaptiveCard) {
      return {
        approved: false,
        reason:
          'This Teams conversation cannot display approval cards right now.',
      };
    }
    if (this.pendingPermissionPrompts.has(request.requestId)) {
      return {
        approved: false,
        reason: 'This approval request is already awaiting a decision.',
      };
    }

    const approvalRequest = { ...request, targetJid: request.targetJid ?? jid };
    try {
      const sent = await this.sdkClient.sendAdaptiveCard({
        conversationId,
        card: buildTeamsApprovalAdaptiveCard(approvalRequest),
        ...(request.threadId ? { threadId: request.threadId } : {}),
      });
      const messageId = sent.externalMessageId;
      bindTeamsPermissionPromptMessage(request, conversationId, messageId);
      return await new Promise<PermissionApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          void this.resolvePermissionPrompt(request.requestId, {
            approved: false,
            decidedBy: 'system',
            reason: 'timed out',
          });
        }, PERMISSION_APPROVAL_TIMEOUT_MS);
        this.pendingPermissionPrompts.set(request.requestId, {
          conversationId,
          sourceAgentFolder: request.sourceAgentFolder,
          decisionPolicy: request.decisionPolicy,
          approvalContextJid: request.approvalContextJid,
          request: approvalRequest,
          threadId: request.threadId,
          timer,
          resolve,
          settled: false,
        });
      });
    } catch (err) {
      logger.error(
        { jid, requestId: request.requestId, err },
        'Failed to send Teams permission prompt',
      );
      return {
        approved: false,
        reason: 'Failed to send approval prompt to Teams',
      };
    }
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    const emptyResponse: UserQuestionResponse = {
      requestId: request.requestId,
      answers: {},
    };
    if (!this.connected) return { ...emptyResponse, answeredBy: 'system' };
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId) return emptyResponse;
    if (!this.sdkClient.sendAdaptiveCard) return emptyResponse;
    if (!request.questions.length) return emptyResponse;
    if (this.pendingUserQuestions.has(request.requestId)) return emptyResponse;

    const questionRequest = { ...request, targetJid: request.targetJid ?? jid };
    try {
      const sent = await this.sdkClient.sendAdaptiveCard({
        conversationId,
        card: buildTeamsUserQuestionCard(questionRequest),
        ...(request.threadId ? { threadId: request.threadId } : {}),
      });
      return await new Promise<UserQuestionResponse>((resolve) => {
        const timer = setTimeout(() => {
          void this.resolvePendingUserQuestion(request.requestId, {
            requestId: request.requestId,
            answers: {},
            answeredBy: 'system',
          });
        }, PERMISSION_APPROVAL_TIMEOUT_MS);
        this.pendingUserQuestions.set(request.requestId, {
          conversationId,
          sourceAgentFolder: request.sourceAgentFolder,
          request: questionRequest,
          threadId: request.threadId,
          timer,
          resolve,
          settled: false,
          ...(sent?.externalMessageId
            ? { messageId: sent.externalMessageId }
            : {}),
        });
      });
    } catch (err) {
      logger.error(
        { jid, requestId: request.requestId, err },
        'Failed to send Teams user question prompt',
      );
      return emptyResponse;
    }
  }

  private async handleUserQuestionSubmit(
    message: TeamsInboundMessage,
    jid: string,
    userId: string,
    userName: string,
  ): Promise<boolean> {
    const submit = readTeamsUserQuestionSubmit(message.value);
    if (!submit) return false;
    const pending = this.pendingUserQuestions.get(submit.requestId);
    if (!pending) {
      await this.resolveDurableUserQuestionSubmit({
        submit,
        jid,
        userId,
        userName,
      });
      return true;
    }
    if (pending.settled) return true;
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId || conversationId !== pending.conversationId) {
      await this.sendDeniedDecisionFeedback(
        conversationId || teamsConversationIdFromJid(jid),
        'This question belongs to a different chat.',
      );
      return true;
    }
    const authorized = await this.canDecidePermission(
      userId,
      pending.sourceAgentFolder,
      undefined,
      jid,
    );
    if (!authorized) {
      await this.sendDeniedDecisionFeedback(
        conversationId,
        'You are not allowed to answer this question.',
      );
      return true;
    }
    const answers = mapTeamsUserQuestionAnswers(pending.request, submit.values);
    await this.resolvePendingUserQuestion(submit.requestId, {
      requestId: submit.requestId,
      answers,
      answeredBy: userName,
    });
    return true;
  }

  private async handleMessageAction(
    message: TeamsInboundMessage,
    jid: string,
    userId: string,
  ): Promise<boolean> {
    return handleTeamsMessageAction({
      message,
      jid,
      userId,
      onMessageAction: this.opts.onMessageAction,
      sendDenied: (conversationId, text) =>
        this.sendDeniedDecisionFeedback(conversationId, text),
    });
  }

  private async resolveDurableUserQuestionSubmit(input: {
    submit: TeamsUserQuestionSubmit;
    jid: string;
    userId: string;
    userName: string;
  }): Promise<void> {
    const conversationId = teamsConversationIdFromJid(input.jid);
    if (!conversationId) return;
    const durable = await findDurableQuestionInteractionByRequestId({
      requestId: input.submit.requestId,
    });
    if (!durable || durable.targetJid !== input.jid || !durable.request) {
      return;
    }
    const authorized = await this.canDecidePermission(
      input.userId,
      durable.sourceAgentFolder,
      undefined,
      input.jid,
    );
    if (!authorized) {
      await this.sendDeniedDecisionFeedback(
        conversationId,
        'You are not allowed to answer this question.',
      );
      return;
    }
    await resolveDurableQuestionAnswersByRequestId({
      requestId: input.submit.requestId,
      answers: mapTeamsUserQuestionAnswers(
        durable.request,
        input.submit.values,
      ),
      answeredBy: input.userName,
    });
  }

  private async resolvePendingUserQuestion(
    requestId: string,
    response: UserQuestionResponse,
  ): Promise<void> {
    const pending = this.pendingUserQuestions.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingUserQuestions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    const answered = Object.keys(response.answers).length > 0;
    const receiptText = answered
      ? formatTeamsUserQuestionReceipt(pending.request, response)
      : 'No answer was recorded for the question.';
    if (this.sdkClient.updateAdaptiveCard && pending.messageId) {
      try {
        await this.sdkClient.updateAdaptiveCard({
          conversationId: pending.conversationId,
          messageId: pending.messageId,
          card: buildTeamsUserQuestionReceiptCard(receiptText),
        });
        return;
      } catch (err) {
        logger.debug(
          { requestId, err },
          'Teams user question receipt card update failed; sending text',
        );
      }
    }
    try {
      await this.sdkClient.sendMessage({
        conversationId: pending.conversationId,
        text: receiptText,
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
      });
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to send Teams user question receipt',
      );
    }
  }

  private async handlePermissionDecision(
    message: TeamsInboundMessage,
    jid: string,
    userId: string,
    userName: string,
  ): Promise<boolean> {
    const decisionPayload = readTeamsPermissionDecision(message.value);
    if (!decisionPayload) return false;
    const pending = this.pendingPermissionPrompts.get(
      decisionPayload.requestId,
    );
    const mode = normalizePermissionAction(decisionPayload.decision);
    if (!pending) {
      if (mode) {
        const durable = await findDurablePermissionInteractionByRequestId({
          requestId: decisionPayload.requestId,
        });
        const authorized =
          durable?.targetJid === jid &&
          (await this.canDecidePermission(
            userId,
            durable.sourceAgentFolder,
            durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
            jid,
          ));
        if (authorized) {
          await resolveDurablePermissionInteractionByRequestId({
            requestId: decisionPayload.requestId,
            mode,
            approverRef: userName,
            reason: `resolved via Teams after channel restart`,
          });
        }
      }
      return true;
    }
    if (pending.settled) return true;
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId || conversationId !== pending.conversationId) {
      logger.warn(
        { requestId: decisionPayload.requestId, jid },
        'Teams permission decision denied: wrong channel',
      );
      await this.sendDeniedDecisionFeedback(
        conversationId || teamsConversationIdFromJid(jid),
        'This approval request belongs to a different chat.',
      );
      return true;
    }
    const authorized = await this.canDecidePermission(
      userId,
      pending.sourceAgentFolder,
      pending.decisionPolicy,
      pending.approvalContextJid || jid,
    );
    if (!authorized) {
      logger.warn(
        { requestId: decisionPayload.requestId, userId, jid },
        'Teams permission decision denied: user is not a control approver',
      );
      await this.sendDeniedDecisionFeedback(
        conversationId,
        'You are not allowed to decide this permission request.',
      );
      return true;
    }
    if (!mode) return true;
    if (!permissionDecisionOptions(pending.request).includes(mode)) {
      await this.sendDeniedDecisionFeedback(
        conversationId,
        'This approval option is no longer available.',
      );
      return true;
    }
    await this.resolvePermissionPrompt(
      decisionPayload.requestId,
      decisionForMode(pending.request, mode, userName),
    );
    return true;
  }

  private async canDecidePermission(
    userId: string,
    sourceAgentFolder: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | undefined,
    conversationJid: string,
  ): Promise<boolean> {
    if (decisionPolicy && decisionPolicy !== 'same_channel') return false;
    if (!this.opts.isControlApproverAllowed) return false;
    return this.opts.isControlApproverAllowed({
      providerId: 'teams',
      conversationJid,
      userId,
      sourceAgentFolder,
      decisionPolicy,
    });
  }

  private async sendDeniedDecisionFeedback(
    conversationId: string | null,
    text: string,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.sdkClient.sendMessage({ conversationId, text });
    } catch (err) {
      logger.debug(
        { conversationId, err },
        'Failed to send Teams permission denial feedback',
      );
    }
  }

  private async resolvePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingPermissionPrompts.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingPermissionPrompts.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    try {
      await this.sdkClient.sendMessage({
        conversationId: pending.conversationId,
        text: formatPermissionReceiptText(requestId, pending.request, decision),
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
      });
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to send Teams permission receipt',
      );
    }
  }
}

export async function createTeamsChannel(
  opts: ChannelOpts,
  deps: TeamsChannelDependencies = {},
): Promise<TeamsChannel | null> {
  const credentials =
    deps.credentials ??
    (await readTeamsCredentials(opts.runtimeSecrets, opts.runtimeSettings?.()));
  if (!credentials) {
    logger.warn(
      'Teams: TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, and TEAMS_TENANT_ID are required',
    );
    return null;
  }
  const sdkClient =
    deps.sdkClient ?? createMicrosoftTeamsSdkClient(credentials);
  if (!sdkClient) {
    logger.warn(
      'Teams: Microsoft Teams SDK transport is not configured for this scaffold',
    );
    return null;
  }
  return new TeamsChannel(credentials, opts, sdkClient);
}

function createMicrosoftTeamsSdkClient(
  _credentials: TeamsChannelCredentials,
): TeamsSdkClient | null {
  return null;
}
