import {
  type ChannelAdapter,
  type ConversationContextHydrationRequest,
} from '../channel-provider.js';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
  NewMessage,
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionApprovalResult,
  ProgressUpdateOptions,
  RichInteractionRequest,
  StreamingChunkOptions,
  UserQuestionCancellation,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { nowIso } from '../../shared/time/datetime.js';
import { resolveTeamsInboundIdentity } from './conversation-context.js';
import {
  buildTeamsUserQuestionCard,
  formatTeamsAttachmentUnavailableCopy as teamsTextWithAttachmentNotice,
} from './cards.js';
import {
  handleTeamsMessageAction,
  teamsMessageActionCardSinks,
} from './message-actions.js';
import {
  sendTeamsProgressUpdate,
  sendTeamsTextOrActionMessage,
  type TeamsProgressMessages,
} from './progress.js';
import {
  prepareTeamsPermissionCardSend,
  requestTeamsPermissionApproval,
} from './permission-approval.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../shared/permission-timeout.js';
import {
  JobPermissionCardDeliverySettlement,
  resolveInteractionSettlementDelayMs,
} from '../interaction-settlement.js';
import { cancelPendingTeamsPermission } from './permission-cancellation.js';
import { renderTeamsAgentTodo, type TeamsTodoMessages } from './todos.js';
import {
  isTeamsJid,
  normalizeTeamsJid,
  teamsConversationIdFromJid,
  type PendingTeamsPermissionPrompt,
  type PendingTeamsUserQuestion,
  type TeamsChannelCredentials,
  type TeamsChannelOpts,
  type TeamsInboundMessage,
  type TeamsSdkClient,
} from './types.js';
import {
  hydrateTeamsConversationContext,
  teamsMessageAttachments as teamsInboundMessageAttachments,
} from './conversation-context.js';
import { renderTeamsRichInteraction } from './rich-interaction.js';
import { teamsDeliveredQuestionIndexes } from './user-question.js';
import { buildTeamsQuestionTimeoutAnswers } from './user-question-timeout.js';
import {
  applyTeamsStreamingChunk,
  type TeamsStreamingState,
} from './streaming.js';
import {
  cancelPendingTeamsQuestion,
  dropPendingTeamsInteraction,
  handleTeamsPermissionDecision,
  handleTeamsUserQuestionSubmit,
  resolvePendingTeamsUserQuestion,
  settlePendingTeamsPermission,
} from './interaction-handlers.js';
import { StreamResetEpochs } from '../stream-reset-epochs.js';
import {
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
  type DurableQuestionCallback,
} from '../../application/interactions/pending-interaction-durability.js';

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
} from './cards.js';
export {
  TEAMS_JID_PREFIX,
  isTeamsJid,
  normalizeTeamsJid,
  teamsConversationIdFromJid,
  type TeamsChannelCredentials,
  type TeamsChannelDependencies,
  type TeamsInboundMessage,
  type TeamsSdkClient,
} from './types.js';
export { createTeamsChannel } from './factory.js';

export class TeamsChannel implements ChannelAdapter {
  name = 'teams';
  readonly liveUx = {
    typing: 'none',
    reactions: 'none',
    canonicalTarget: (target: { jid: string }) => ({ key: target.jid }),
  } as const;
  private connected = false;
  private outboundReady = false;
  private readonly pendingPermissionPrompts = new Map<
    string,
    PendingTeamsPermissionPrompt
  >();
  private readonly pendingTodos: TeamsTodoMessages = new Map();
  private readonly pendingProgress: TeamsProgressMessages = new Map();
  private readonly jobPermissionCardDeliveries =
    new JobPermissionCardDeliverySettlement();
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
  async cancelPendingPermission(
    cancellation: PermissionApprovalCancellation,
  ): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'> {
    return cancelPendingTeamsPermission(
      this.pendingPermissionPrompts,
      cancellation,
      (providerAlias, reason) =>
        settlePendingTeamsPermission(
          this.interactionContext(),
          providerAlias,
          'cancel',
          'runtime',
          reason,
        ),
    );
  }
  cancelPendingQuestion(cancellation: UserQuestionCancellation) {
    return cancelPendingTeamsQuestion(this.interactionContext(), cancellation);
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
      jobPermissionCardDeliveries: this.jobPermissionCardDeliveries,
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

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<boolean> {
    if (!this.outboundReady) return false;
    return sendTeamsProgressUpdate({
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

    const isGroup = message.conversationType !== 'personal';
    const messageIdentity = await resolveTeamsInboundIdentity({
      opts: this.opts,
      jid,
      timestamp,
      conversationName: message.conversationName,
      threadId: message.threadId,
      isGroup,
    });

    const normalized: NewMessage = {
      id: message.id || `teams:${message.conversationId}:${timestamp}`,
      chat_jid: jid,
      ...messageIdentity,
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
  ): Promise<PermissionApprovalResult> {
    return requestTeamsPermissionApproval({
      connected: this.connected,
      jid,
      request,
      timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
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

  preparePermissionCardSend(
    jid: string,
    _text: string,
    options: MessageSendOptions & {
      permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
    },
  ) {
    return prepareTeamsPermissionCardSend({
      connected: this.outboundReady,
      jid,
      options,
      sdkClient: this.sdkClient,
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
        const { expiresAt, permissionLane } =
          questionRequest as UserQuestionRequest & {
            expiresAt?: unknown;
            permissionLane?: 'interactive' | 'autonomous';
          };
        const settlementDelayMs = resolveInteractionSettlementDelayMs({
          expiresAt,
          permissionLane,
          fallbackTimeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
        });
        let timer!: ReturnType<typeof setTimeout>;
        if (settlementDelayMs !== undefined) {
          timer = setTimeout(() => {
            void (async () => {
              const { remainingQuestionIndexes, timeoutAnswers } =
                buildTeamsQuestionTimeoutAnswers(request, startIndex);
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
          }, settlementDelayMs);
          timer.unref?.();
        }
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
      ...teamsMessageActionCardSinks(this.sdkClient),
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
