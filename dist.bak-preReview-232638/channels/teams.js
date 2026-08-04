import { logger } from '../infrastructure/logging/logger.js';
import { nowIso } from '../shared/time/datetime.js';
import { buildTeamsUserQuestionCard, formatTeamsAttachmentUnavailableCopy as teamsTextWithAttachmentNotice, } from './teams-cards.js';
import { handleTeamsMessageAction } from './teams-message-actions.js';
import { sendTeamsProgressUpdate, sendTeamsTextOrActionMessage, } from './teams-progress.js';
import { requestTeamsPermissionApproval } from './teams-permission-approval.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { resolveInteractionSettlementDelayMs } from './interaction-settlement.js';
import { cancelPendingTeamsPermission } from './teams-permission-cancellation.js';
import { renderTeamsAgentTodo } from './teams-todos.js';
import { isTeamsJid, normalizeTeamsJid, readTeamsCredentials, teamsConversationIdFromJid, } from './teams-types.js';
import { hydrateTeamsConversationContext, teamsMessageAttachments as teamsInboundMessageAttachments, } from './teams-conversation-context.js';
import { renderTeamsRichInteraction } from './teams-rich-interaction.js';
import { teamsDeliveredQuestionIndexes } from './teams-user-question.js';
import { buildTeamsQuestionTimeoutAnswers } from './teams-user-question-timeout.js';
import { createMicrosoftTeamsSdkClient } from './teams-sdk-client.js';
import { applyTeamsStreamingChunk, } from './teams-streaming.js';
import { cancelPendingTeamsQuestion, dropPendingTeamsInteraction, handleTeamsPermissionDecision, handleTeamsUserQuestionSubmit, resolvePendingTeamsUserQuestion, settlePendingTeamsPermission, } from './teams-interaction-handlers.js';
import { StreamResetEpochs } from './stream-reset-epochs.js';
import { DurableInteractionPersistenceError, recordDurableQuestionAnswerProgress, } from '../application/interactions/pending-interaction-durability.js';
export { TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, buildTeamsAgentTodoCard, buildTeamsApprovalAdaptiveCard, buildTeamsApprovalDescriptorPayload, buildTeamsUserQuestionCard, buildTeamsUserQuestionReceiptCard, } from './teams-cards.js';
export { TEAMS_JID_PREFIX, isTeamsJid, normalizeTeamsJid, teamsConversationIdFromJid, } from './teams-types.js';
export class TeamsChannel {
    credentials;
    opts;
    sdkClient;
    name = 'teams';
    connected = false;
    outboundReady = false;
    pendingPermissionPrompts = new Map();
    pendingTodos = new Map();
    pendingProgress = new Map();
    activeStreams = new Map();
    streamResetEpochs = new StreamResetEpochs();
    streamGenerationByJid = new Map();
    sealedStreamGenerationByJid = new Map();
    pendingUserQuestions = new Map();
    constructor(credentials, opts, sdkClient) {
        this.credentials = credentials;
        this.opts = opts;
        this.sdkClient = sdkClient;
    }
    dropPendingInteraction(kind, request) {
        dropPendingTeamsInteraction(this.interactionContext(), kind, request);
    }
    async cancelPendingPermission(cancellation) {
        return cancelPendingTeamsPermission(this.pendingPermissionPrompts, cancellation, (providerAlias, reason) => settlePendingTeamsPermission(this.interactionContext(), providerAlias, 'cancel', 'runtime', reason));
    }
    cancelPendingQuestion(cancellation) {
        return cancelPendingTeamsQuestion(this.interactionContext(), cancellation);
    }
    async connect(options = {}) {
        if (this.connected || this.outboundReady)
            return;
        const inboundEnabled = options.inbound !== false;
        const interactionCallbacksEnabled = options.interactionCallbacks ?? inboundEnabled;
        await this.sdkClient.start({
            credentials: this.credentials,
            onMessage: async (message) => {
                if (inboundEnabled) {
                    await this.ingestMessage(message);
                    return;
                }
                if (!interactionCallbacksEnabled)
                    return;
                const jid = normalizeTeamsJid(message.conversationId);
                if (!jid)
                    return;
                const sender = message.senderId || message.from?.id || 'unknown';
                const senderName = message.senderName || message.from?.name || sender;
                const handledPermission = await this.handlePermissionDecision(message, jid, sender, senderName);
                const handledAction = !handledPermission &&
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
    isConnected() {
        return this.connected || this.outboundReady;
    }
    async disconnect() {
        if (!this.connected && !this.outboundReady)
            return;
        for (const providerAlias of this.pendingPermissionPrompts.keys()) {
            const result = await settlePendingTeamsPermission(this.interactionContext(), providerAlias, 'cancel', 'system', 'Teams channel disconnected');
            if (result === 'already_decided')
                continue;
            const pending = this.pendingPermissionPrompts.get(providerAlias);
            if (!pending)
                continue;
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
        if (this.connected)
            await this.sdkClient.stop();
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
    ownsJid(jid) {
        return isTeamsJid(jid);
    }
    async hydrateConversationContext(request) {
        return hydrateTeamsConversationContext(request, this.sdkClient, this.credentials.clientId);
    }
    async sendMessage(jid, text, options = {}) {
        if (!this.outboundReady)
            return;
        return sendTeamsTextOrActionMessage({
            sdkClient: this.sdkClient,
            jid,
            text: teamsTextWithAttachmentNotice(text, Boolean(options.files?.length)),
            options,
        });
    }
    async renderRichInteraction(jid, render) {
        if (!this.outboundReady)
            return false;
        return renderTeamsRichInteraction({
            sdkClient: this.sdkClient,
            jid,
            render,
            sendFallback: (text, options) => this.sendMessage(jid, text, options),
        });
    }
    async addReaction() { }
    async sendProgressUpdate(jid, text, options = {}) {
        if (!this.outboundReady)
            return;
        await sendTeamsProgressUpdate({
            sdkClient: this.sdkClient,
            pendingProgress: this.pendingProgress,
            jid,
            text,
            options,
        });
    }
    async sendStreamingChunk(jid, text, options = {}) {
        if (!this.outboundReady)
            return false;
        if (!this.shouldAcceptStreamingChunk(jid, options.generation))
            return false;
        const conversationId = teamsConversationIdFromJid(jid);
        if (!conversationId)
            return false;
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
            if (!this.streamResetEpochs.isCurrent(key, streamEpoch) ||
                this.activeStreams.get(key) !== state) {
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
                shouldContinue: () => this.streamResetEpochs.isCurrent(key, streamEpoch) &&
                    this.activeStreams.get(key) === state,
            });
            if (!deliveryStreams.has(key) &&
                this.streamResetEpochs.isCurrent(key, streamEpoch) &&
                this.activeStreams.get(key) === state) {
                this.streamResetEpochs.deleteState(key, this.activeStreams);
                this.markStreamingGenerationDone(jid, options.generation);
            }
            return delivered;
        };
        state.pendingDelivery = state.pendingDelivery.then(run, run);
        return state.pendingDelivery;
    }
    resetStreaming(jid, options) {
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
    async renderAgentTodo(jid, render) {
        if (!this.outboundReady)
            return false;
        return renderTeamsAgentTodo({
            sdkClient: this.sdkClient,
            pendingTodos: this.pendingTodos,
            jid,
            render,
        });
    }
    streamKey(jid, threadId) {
        return `${jid}\n${threadId ?? ''}`;
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
    async ingestMessage(message) {
        const jid = normalizeTeamsJid(message.conversationId);
        if (!jid)
            return;
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
        if (!content && attachments.length === 0)
            return;
        await this.opts.onChatMetadata(jid, timestamp, message.conversationName, 'teams', message.conversationType !== 'personal', { providerAccountId: this.opts.providerAccountId });
        const normalized = {
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
    async requestPermissionApproval(jid, request, onPromptDelivered) {
        return requestTeamsPermissionApproval({
            connected: this.connected,
            jid,
            request,
            timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
            onPromptDelivered,
            sdkClient: this.sdkClient,
            pendingPermissionPrompts: this.pendingPermissionPrompts,
            settleTimeout: (providerAlias) => settlePendingTeamsPermission(this.interactionContext(), providerAlias, 'cancel', 'system', 'timed out'),
        });
    }
    async requestUserAnswer(jid, request, onPromptDelivered) {
        const emptyResponse = {
            requestId: request.requestId,
            answers: {},
        };
        if (!this.connected)
            return { ...emptyResponse, answeredBy: 'system' };
        const conversationId = teamsConversationIdFromJid(jid);
        if (!conversationId)
            return emptyResponse;
        if (!this.sdkClient.sendAdaptiveCard)
            return emptyResponse;
        if (!request.questions.length)
            return emptyResponse;
        const startIndex = 0;
        const questionRequest = { ...request, targetJid: request.targetJid ?? jid };
        const callback = {
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
            const response = new Promise((resolve, reject) => {
                const { expiresAt, permissionLane } = questionRequest;
                const settlementDelayMs = resolveInteractionSettlementDelayMs({
                    expiresAt,
                    permissionLane,
                    fallbackTimeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
                });
                let timer;
                if (settlementDelayMs !== undefined) {
                    timer = setTimeout(() => {
                        void (async () => {
                            const { remainingQuestionIndexes, timeoutAnswers } = buildTeamsQuestionTimeoutAnswers(request, startIndex);
                            const recorded = await recordDurableQuestionAnswerProgress({
                                requestId: request.requestId,
                                appId: request.appId,
                                sourceAgentFolder: request.sourceAgentFolder,
                                answers: timeoutAnswers,
                                completedQuestionIndexes: remainingQuestionIndexes,
                            });
                            if (!recorded) {
                                throw new DurableInteractionPersistenceError('Teams user question timeout was not persisted');
                            }
                            await this.resolvePendingUserQuestion(callback.providerAlias, {
                                requestId: request.requestId,
                                answers: timeoutAnswers,
                                answeredBy: 'system',
                            });
                        })().catch((err) => {
                            reject(err instanceof DurableInteractionPersistenceError
                                ? err
                                : new DurableInteractionPersistenceError('Teams user question timeout could not be persisted', err));
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
        }
        catch (err) {
            logger.error({ jid, requestId: request.requestId, err }, 'Failed to send Teams user question prompt');
            if (err instanceof DurableInteractionPersistenceError)
                throw err;
            return emptyResponse;
        }
    }
    questionIndexesForDeliveredPrompt = teamsDeliveredQuestionIndexes;
    async handleUserQuestionSubmit(message, jid, userId, userName) {
        return handleTeamsUserQuestionSubmit({
            message,
            jid,
            userId,
            userName,
            context: this.interactionContext(),
        });
    }
    async handleMessageAction(message, jid, userId) {
        return handleTeamsMessageAction({
            message,
            jid,
            userId,
            providerAccountId: this.opts.providerAccountId,
            onMessageAction: this.opts.onMessageAction,
            sendDenied: async (conversationId, text) => {
                if (!conversationId)
                    return;
                try {
                    await this.sdkClient.sendMessage({ conversationId, text });
                }
                catch (err) {
                    logger.debug({ conversationId, err }, 'Failed to send Teams permission denial feedback');
                }
            },
        });
    }
    async resolvePendingUserQuestion(providerAlias, response) {
        await resolvePendingTeamsUserQuestion(this.interactionContext(), providerAlias, response);
    }
    async handlePermissionDecision(message, jid, userId, userName) {
        return handleTeamsPermissionDecision({
            message,
            jid,
            userId,
            userName,
            context: this.interactionContext(),
        });
    }
    interactionContext() {
        return {
            opts: this.opts,
            sdkClient: this.sdkClient,
            pendingPermissionPrompts: this.pendingPermissionPrompts,
            pendingUserQuestions: this.pendingUserQuestions,
        };
    }
}
export async function createTeamsChannel(opts, deps = {}) {
    const credentials = deps.credentials ??
        (await readTeamsCredentials(opts.runtimeSecrets, opts.runtimeSettings?.(), opts.providerAccountId));
    if (!credentials) {
        logger.warn('Teams: TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, and TEAMS_TENANT_ID are required');
        return null;
    }
    const sdkClient = deps.sdkClient ?? createMicrosoftTeamsSdkClient(credentials);
    if (!sdkClient) {
        logger.warn('Teams: Microsoft Teams SDK transport is not configured for this scaffold');
        return null;
    }
    return new TeamsChannel(credentials, opts, sdkClient);
}
