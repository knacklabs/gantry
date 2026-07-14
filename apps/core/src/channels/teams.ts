import {
  type ChannelAdapter,
  type ChannelOpts,
  type ConversationContextHydrationRequest,
} from './channel-provider.js';
import type {
  AdaptiveCardPayload,
  MessageDeliveryResult,
  MessageSendOptions,
  NewMessage,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  RichInteractionRequest,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { logger } from '../infrastructure/logging/logger.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { handleExternalCardAction } from './teams-external-card-actions.js';
import { forwardExternalTeamsReply } from './teams-external-reply-forwarding.js';
import { nowIso } from '../shared/time/datetime.js';
import { createTeamsBotFrameworkSdkClient } from './teams-bot-framework-client.js';
import {
  buildTeamsApprovalAdaptiveCard,
  buildTeamsUserQuestionCard,
  type TeamsAdaptiveCardPayload,
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
import { renderTeamsRichInteraction } from './teams-rich-interaction.js';
import {
  applyTeamsStreamingChunk,
  type TeamsStreamingState,
} from './teams-streaming.js';
import {
  handleTeamsPermissionDecision,
  handleTeamsUserQuestionSubmit,
  resolvePendingTeamsUserQuestion,
  resolveTeamsPermissionPrompt,
} from './teams-interaction-handlers.js';

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

  async sendAdaptiveCard(
    jid: string,
    card: AdaptiveCardPayload,
    options: MessageSendOptions = {},
  ): Promise<MessageDeliveryResult | void> {
    if (!this.outboundReady) return;
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId) return;
    if (!this.sdkClient.sendAdaptiveCard) {
      throw new Error('Teams SDK client cannot send Adaptive Cards');
    }
    const sent = await this.sdkClient.sendAdaptiveCard({
      conversationId,
      card: card as unknown as TeamsAdaptiveCardPayload,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
    return sent.externalMessageId
      ? { externalMessageId: sent.externalMessageId }
      : {};
  }

  async renderRichInteraction(
    jid: string,
    render: RichInteractionRequest,
  ): Promise<boolean> {
    if (!this.outboundReady) return false;
    return renderTeamsRichInteraction({
      sdkClient: this.sdkClient,
      jid,
      render,
      sendFallback: (text, options) => this.sendMessage(jid, text, options),
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
      applyTeamsStreamingChunk({
        jid,
        key,
        state,
        text,
        options,
        activeStreams: this.activeStreams,
        sdkClient: this.sdkClient,
        markDone: (doneJid, generation) =>
          this.markStreamingGenerationDone(doneJid, generation),
      });
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
    if (
      await handleExternalCardAction({
        message,
        sdkClient: this.sdkClient,
      })
    ) {
      return;
    }

    const content = message.text?.trim() || '';
    const attachments = teamsInboundMessageAttachments(message);
    if (!content && attachments.length === 0) return;
    if (await forwardExternalTeamsReply(message)) {
      return;
    }

    await this.opts.onChatMetadata(
      jid,
      timestamp,
      message.conversationName,
      'teams',
      message.conversationType !== 'personal',
      { providerAccountId: this.opts.providerAccountId },
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
    return handleTeamsUserQuestionSubmit({
      message,
      jid,
      userId,
      userName,
      context: this.interactionContext(),
    });
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
      providerAccountId: this.opts.providerAccountId,
      onMessageAction: this.opts.onMessageAction,
      sendDenied: async (conversationId, text) => {
        if (!conversationId) return;
        try {
          await this.sdkClient.sendMessage({ conversationId, text });
        } catch (err) {
          logger.debug(
            { conversationId, err },
            'Failed to send Teams permission denial feedback',
          );
        }
      },
    });
  }

  private async resolvePendingUserQuestion(
    requestId: string,
    response: UserQuestionResponse,
  ): Promise<void> {
    await resolvePendingTeamsUserQuestion(
      this.interactionContext(),
      requestId,
      response,
    );
  }

  private async handlePermissionDecision(
    message: TeamsInboundMessage,
    jid: string,
    userId: string,
    userName: string,
  ): Promise<boolean> {
    return handleTeamsPermissionDecision({
      message,
      jid,
      userId,
      userName,
      context: this.interactionContext(),
    });
  }

  private async resolvePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
  ): Promise<void> {
    await resolveTeamsPermissionPrompt(
      this.interactionContext(),
      requestId,
      decision,
    );
  }

  private interactionContext() {
    return {
      opts: this.opts,
      sdkClient: this.sdkClient,
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      pendingUserQuestions: this.pendingUserQuestions,
    };
  }
}

export async function createTeamsChannel(
  opts: ChannelOpts,
  deps: TeamsChannelDependencies = {},
): Promise<TeamsChannel | null> {
  const credentials =
    deps.credentials ??
    (await readTeamsCredentials(
      opts.runtimeSecrets,
      opts.runtimeSettings?.(),
      opts.providerAccountId,
    ));
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
      'Teams: Microsoft Teams Bot Framework transport is not configured',
    );
    return null;
  }
  return new TeamsChannel(credentials, opts, sdkClient);
}

function createMicrosoftTeamsSdkClient(
  _credentials: TeamsChannelCredentials,
): TeamsSdkClient | null {
  return createTeamsBotFrameworkSdkClient();
}
