import {
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
  RichInteractionRequest,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { logger } from '../infrastructure/logging/logger.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  buildTeamsUserQuestionCard,
  formatTeamsAttachmentUnavailableCopy as teamsTextWithAttachmentNotice,
} from './teams-cards.js';
import { handleTeamsMessageAction } from './teams-message-actions.js';
import {
  sendTeamsProgressUpdate,
  sendTeamsTextOrActionMessage,
  type TeamsProgressMessages,
} from './teams-progress.js';
import { requestTeamsPermissionApproval } from './teams-permission-approval.js';
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
import { teamsDeliveredQuestionIndexes } from './teams-user-question.js';
import { createMicrosoftTeamsSdkClient } from './teams-sdk-client.js';
import {
  applyTeamsStreamingChunk,
  type TeamsStreamingState,
} from './teams-streaming.js';
import {
  dropPendingTeamsInteraction,
  handleTeamsPermissionDecision,
  handleTeamsUserQuestionSubmit,
  resolvePendingTeamsUserQuestion,
  settlePendingTeamsPermission,
} from './teams-interaction-handlers.js';
import { StreamResetEpochs } from './stream-reset-epochs.js';
import {
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
  type DurableQuestionCallback,
} from '../application/interactions/pending-interaction-durability.js';

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
  private readonly streamResetEpochs = new StreamResetEpochs();
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
  dropPendingInteraction(
    kind: 'permission' | 'question',
    request: PermissionApprovalRequest | UserQuestionRequest,
  ): void {
    dropPendingTeamsInteraction(this.interactionContext(), kind, request);
  }

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
    for (const providerAlias of this.pendingPermissionPrompts.keys()) {
      const result = await settlePendingTeamsPermission(
        this.interactionContext(),
        providerAlias,
        'cancel',
        'system',
        'Teams channel disconnected',
      );
      if (result === 'already_decided') continue;
      const pending = this.pendingPermissionPrompts.get(providerAlias);
      if (!pending) continue;
      clearTimeout(pending.timer);
      pending.settled = true;
      this.pendingPermissionPrompts.delete(providerAlias);
      pending.resolve({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      });
    }
    if (this.connected) await this.sdkClient.stop();
    for (const [providerAlias, pending] of this.pendingUserQuestions) {
      await this.resolvePendingUserQuestion(providerAlias, {
        requestId: pending.request.requestId,
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
    const streamEpoch = this.streamResetEpochs.current(key);
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

    const run = async () => {
      if (
        !this.streamResetEpochs.isCurrent(key, streamEpoch) ||
        this.activeStreams.get(key) !== state
      ) {
        return false;
      }
      const deliveryStreams = new Map([[key, state]]);
      const delivered = await applyTeamsStreamingChunk({
        jid,
        key,
        state,
        text,
        options,
        activeStreams: deliveryStreams,
        sdkClient: this.sdkClient,
        markDone: () => undefined,
        shouldContinue: () =>
          this.streamResetEpochs.isCurrent(key, streamEpoch) &&
          this.activeStreams.get(key) === state,
      });
      if (
        !deliveryStreams.has(key) &&
        this.streamResetEpochs.isCurrent(key, streamEpoch) &&
        this.activeStreams.get(key) === state
      ) {
        this.streamResetEpochs.deleteState(key, this.activeStreams);
        this.markStreamingGenerationDone(jid, options.generation);
      }
      return delivered;
    };
    state.pendingDelivery = state.pendingDelivery.then(run, run);
    return state.pendingDelivery;
  }

  resetStreaming(jid: string, options?: { threadId?: string }): void {
    if (options) {
      const key = this.streamKey(jid, options.threadId);
      this.streamResetEpochs.bump(key);
      this.streamResetEpochs.deleteState(key, this.activeStreams);
      return;
    }
    this.streamResetEpochs.bumpMatching(this.activeStreams.keys(), `${jid}\n`);
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
      if (!key.startsWith(`${jid}\n`)) continue;
      this.streamResetEpochs.deleteState(key, this.activeStreams);
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

    const content = message.text?.trim() || '';
    const attachments = teamsInboundMessageAttachments(message);
    if (!content && attachments.length === 0) return;

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
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalDecision> {
    return requestTeamsPermissionApproval({
      connected: this.connected,
      jid,
      request,
      onPromptDelivered,
      sdkClient: this.sdkClient,
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      settleTimeout: (providerAlias) =>
        settlePendingTeamsPermission(
          this.interactionContext(),
          providerAlias,
          'cancel',
          'system',
          'timed out',
        ),
    });
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void,
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
    const startIndex = 0;
    const questionRequest = { ...request, targetJid: request.targetJid ?? jid };
    const callback: DurableQuestionCallback = {
      providerAlias: globalThis.crypto.randomUUID(),
      scope: {
        appId: request.appId || 'default',
        sourceAgentFolder: request.sourceAgentFolder,
        interactionId: request.requestId,
      },
      questionIndex: startIndex,
    };
    if (this.pendingUserQuestions.has(callback.providerAlias)) {
      return emptyResponse;
    }
    try {
      const sent = await this.sdkClient.sendAdaptiveCard({
        conversationId,
        card: buildTeamsUserQuestionCard(questionRequest, callback, startIndex),
        ...(request.threadId ? { threadId: request.threadId } : {}),
      });
      const response = new Promise<UserQuestionResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          void (async () => {
            const remainingQuestionIndexes = request.questions.flatMap(
              (_, index) => (index >= startIndex ? [index] : []),
            );
            const timeoutAnswers = Object.fromEntries(
              remainingQuestionIndexes.map((questionIndex) => {
                const question = request.questions[questionIndex]!;
                return [
                  question.question,
                  question.multiSelect ? ([] as string[]) : '',
                ];
              }),
            );
            const recorded = await recordDurableQuestionAnswerProgress({
              requestId: request.requestId,
              appId: request.appId,
              sourceAgentFolder: request.sourceAgentFolder,
              answers: timeoutAnswers,
              completedQuestionIndexes: remainingQuestionIndexes,
            });
            if (!recorded) {
              throw new DurableInteractionPersistenceError(
                'Teams user question timeout was not persisted',
              );
            }
            await this.resolvePendingUserQuestion(callback.providerAlias, {
              requestId: request.requestId,
              answers: timeoutAnswers,
              answeredBy: 'system',
            });
          })().catch((err) => {
            reject(
              err instanceof DurableInteractionPersistenceError
                ? err
                : new DurableInteractionPersistenceError(
                    'Teams user question timeout could not be persisted',
                    err,
                  ),
            );
          });
        }, PERMISSION_APPROVAL_TIMEOUT_MS);
        this.pendingUserQuestions.set(callback.providerAlias, {
          callback,
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
      if (sent?.externalMessageId) {
        onPromptDelivered?.(sent.externalMessageId, startIndex);
      }
      return response;
    } catch (err) {
      logger.error(
        { jid, requestId: request.requestId, err },
        'Failed to send Teams user question prompt',
      );
      if (err instanceof DurableInteractionPersistenceError) throw err;
      return emptyResponse;
    }
  }

  questionIndexesForDeliveredPrompt = teamsDeliveredQuestionIndexes;

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
    providerAlias: string,
    response: UserQuestionResponse,
  ): Promise<void> {
    await resolvePendingTeamsUserQuestion(
      this.interactionContext(),
      providerAlias,
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
      'Teams: Microsoft Teams SDK transport is not configured for this scaffold',
    );
    return null;
  }
  return new TeamsChannel(credentials, opts, sdkClient);
}
