import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { folderForAgentId } from '../../domain/agent/agent-folder-id.js';
import { ApplicationError } from '../common/application-error.js';
import { isValidControlId } from '../../shared/control-id.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
export class SessionInteractionModule {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async ensureSession(input) {
        assertAppScope(input.appId, input.assertedAppId);
        const conversationId = input.conversationId.trim();
        if (!conversationId) {
            throw new ApplicationError('INVALID_REQUEST', 'conversationId is required');
        }
        if (!isValidControlId(input.appId) || !isValidControlId(conversationId)) {
            throw new ApplicationError('INVALID_REQUEST', 'appId and conversationId must contain only letters, numbers, dot, underscore, or dash');
        }
        const conversationJid = `app:${input.appId}:${conversationId}`;
        let group = makeAppGroup({
            appId: input.appId,
            conversationId,
            conversationJid,
            identityHash: this.deps
                .stableHash(`${input.appId}\0${conversationId}`)
                .slice(0, 12),
            addedAt: this.deps.now(),
        });
        const requestedAgentId = input.agentId?.trim();
        if (requestedAgentId) {
            const agent = await this.deps.repositories.agents.getAgent(requestedAgentId);
            if (!agent || agent.appId !== input.appId) {
                throw new ApplicationError('NOT_FOUND', 'Agent not found');
            }
            if (agent.status !== 'active') {
                throw new ApplicationError('INVALID_REQUEST', `Agent is not active: ${requestedAgentId}`);
            }
            const agentFolder = folderForAgentId(agent.id);
            if (!agentFolder) {
                throw new ApplicationError('INVALID_REQUEST', 'Agent does not have a settings folder.');
            }
            // Bind the session to the requested agent's workspace folder so turns
            // run with that agent's config and grants instead of a synthetic one.
            group = { ...group, name: agent.name, folder: agentFolder };
        }
        const defaultWebhookId = await this.resolveOwnedWebhookId(input.appId, input.webhookId ?? null);
        const session = await this.deps.control.ensureAppSession({
            appId: input.appId,
            conversationId,
            conversationJid,
            folder: group.folder,
            title: input.title ?? null,
            defaultResponseMode: normalizeResponseMode(input.responseMode, 'sse'),
            defaultWebhookId,
        });
        return { session, registerGroup: { conversationJid, group } };
    }
    async getSessionDetails(input) {
        const appSession = await this.requireSession(input);
        const session = await this.deps.repositories.agentSessions.getAgentSession(appSession.sessionId);
        if (!session) {
            throw new ApplicationError('NOT_FOUND', 'Session not found');
        }
        const providerSession = await this.deps.repositories.providerSessions.getLatestProviderSession({
            agentSessionId: session.id,
        });
        return {
            session,
            providerSession: providerSession
                ? {
                    provider: providerSession.provider,
                    status: providerSession.status,
                    hasProviderResume: hasProviderResumeHandle(providerSession),
                    createdAt: providerSession.createdAt,
                    updatedAt: providerSession.updatedAt,
                }
                : null,
        };
    }
    async listMessages(input) {
        const session = await this.requireSession(input);
        if (!session.conversationId)
            return { messages: [] };
        // The session stores its SHORT conversation id; canonical message rows
        // key on conversation-row ids, and one jid can map to several rows until
        // the Phase-8 restamp — resolve by jid and union.
        const conversationIds = await this.deps.repositories.messages.listConversationIdsForJid(session.conversationJid);
        if (conversationIds.length === 0)
            return { messages: [] };
        const lists = await Promise.all(conversationIds.map((conversationId) => this.deps.repositories.messages.listRecentMessages({
            conversationId,
            limit: input.limit,
        })));
        const messages = lists
            .flat()
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
            .slice(-input.limit);
        return { messages };
    }
    async listRuns(input) {
        const appSession = await this.requireSession(input);
        const session = await this.deps.repositories.agentSessions.getAgentSession(appSession.sessionId);
        if (!session)
            return { runs: [] };
        const runs = await this.deps.repositories.agentRuns.listAgentRunsBySession({
            sessionId: session.id,
            limit: input.limit,
        });
        return { runs };
    }
    async acceptMessage(input) {
        const session = await this.requireSession(input);
        const text = input.message.trim();
        if (!text) {
            throw new ApplicationError('INVALID_REQUEST', 'message is required');
        }
        if (input.responseSchema &&
            this.deps.getConfiguredAgentRuntime?.(session.workspaceKey) !== 'inline') {
            throw new ApplicationError('INVALID_REQUEST', 'response_schema requires an inline agent runtime');
        }
        const threadId = input.threadId?.trim() || null;
        const responseMode = normalizeResponseMode(input.responseMode, session.defaultResponseMode);
        const webhookId = await this.resolveOwnedWebhookId(input.appId, input.webhookId ?? session.defaultWebhookId);
        const now = this.deps.now();
        const messageId = this.deps.createId();
        const message = {
            id: messageId,
            chat_jid: session.conversationJid,
            provider: 'app',
            sender: input.senderId ?? 'sdk',
            sender_name: input.senderName ?? 'SDK',
            content: text,
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
            external_message_id: messageId,
            thread_id: threadId ?? undefined,
            responseSchema: input.responseSchema,
            agentControls: input.agentControls,
        };
        await this.deps.ops.storeChatMetadata(session.conversationJid, now, session.title ?? session.conversationJid, 'app', true);
        await this.deps.control.upsertAppResponseRoute({
            sessionId: session.sessionId,
            threadId,
            responseMode,
            webhookId,
            correlationId: input.correlationId ?? null,
        });
        const acceptedEvent = {
            appId: session.appId,
            eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
            payload: {
                messageId,
                text,
                threadId,
            },
            actor: 'sdk',
            sessionId: session.sessionId,
            threadId: threadId ? threadId : undefined,
            correlationId: input.correlationId ?? null,
            responseMode,
            webhookId,
        };
        let durableAdmissionCreated = false;
        let admissionResult;
        let accepted;
        const runtimeEventsWithLiveAdmission = this.deps.runtimeEvents;
        const publishWithLiveAdmissionMessage = runtimeEventsWithLiveAdmission.publishWithLiveAdmissionMessage?.bind(this.deps.runtimeEvents);
        const useDurableAdmission = input.durableLiveAdmission !== false &&
            publishWithLiveAdmissionMessage &&
            this.deps.liveAdmissionAppId !== null;
        if (useDurableAdmission) {
            await input.beforeDurableAdmission?.();
            const liveAdmissionAppId = this.deps.liveAdmissionAppId ?? session.appId;
            const result = await publishWithLiveAdmissionMessage(acceptedEvent, {
                message,
                liveAdmission: {
                    appId: liveAdmissionAppId,
                    triggerDecision: {
                        source: 'sdk_session',
                        responseMode,
                    },
                    now,
                },
            });
            accepted = result.event;
            admissionResult = result.liveAdmissionResult;
            durableAdmissionCreated =
                !!admissionResult && admissionResult.outcome !== 'overloaded';
        }
        else {
            await this.deps.ops.storeMessage(message);
            accepted = await this.deps.runtimeEvents.publish(acceptedEvent);
        }
        if (admissionResult && admissionResult.outcome !== 'overloaded') {
            await this.deps.ops.notifyLiveAdmissionWorkItem?.(admissionResult);
        }
        return {
            accepted: true,
            messageId,
            acceptedEventId: accepted.eventId,
            enqueue: {
                conversationJid: session.conversationJid,
                threadId,
                queueKey: makeSessionQueueKey(session.conversationJid, threadId),
                durableAdmissionCreated,
            },
        };
    }
    async listEvents(input) {
        const session = await this.requireSession(input);
        return this.deps.runtimeEvents.list(this.eventFilter(session, input));
    }
    async subscribeEvents(input) {
        const session = await this.requireSession(input);
        return this.deps.runtimeEvents.subscribe(this.eventFilter(session, input));
    }
    async waitForVisibleEvent(input) {
        const subscription = await this.subscribeEvents(input);
        const startedAt = currentTimeMs();
        try {
            while (currentTimeMs() - startedAt < input.timeoutMs) {
                const remaining = input.timeoutMs - (currentTimeMs() - startedAt);
                const events = await subscription.next({ timeoutMs: remaining });
                const visible = events.find(isVisibleWaitEvent);
                if (visible)
                    return visible;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        finally {
            subscription.close();
        }
        throw new ApplicationError('WAIT_TIMEOUT', 'Timed out waiting for session event');
    }
    async publishOutboundEvent(input) {
        const session = await this.deps.control.getAppSessionByChatJid(input.conversationJid);
        if (!session)
            return { emitted: false };
        const threadId = typeof input.payload.threadId === 'string'
            ? input.payload.threadId
            : null;
        const route = await this.deps.control.getAppResponseRoute({
            sessionId: session.sessionId,
            threadId,
        });
        const event = await this.deps.runtimeEvents.publish({
            appId: session.appId,
            eventType: input.eventType,
            payload: input.payload,
            actor: 'agent',
            sessionId: session.sessionId,
            threadId: threadId ? threadId : undefined,
            correlationId: route?.correlationId ?? null,
            responseMode: route?.responseMode ?? session.defaultResponseMode,
            webhookId: route ? route.webhookId : session.defaultWebhookId,
        });
        return { emitted: true, eventId: event.eventId };
    }
    async requireSession(input) {
        const session = await this.deps.control.getAppSessionById(input.sessionId);
        if (!session) {
            throw new ApplicationError('NOT_FOUND', 'Session not found');
        }
        if (session.appId !== input.appId) {
            throw new ApplicationError('FORBIDDEN', 'API key cannot access this session');
        }
        return session;
    }
    async resolveOwnedWebhookId(appId, rawWebhookId) {
        const webhookId = rawWebhookId?.trim();
        if (!webhookId)
            return null;
        const webhook = await this.deps.control.getWebhookById(webhookId, appId);
        if (!webhook) {
            throw new ApplicationError('NOT_FOUND', 'Webhook not found');
        }
        return webhook.webhookId;
    }
    eventFilter(session, input) {
        return {
            appId: session.appId,
            sessionId: session.sessionId,
            afterEventId: input.afterEventId && input.afterEventId > 0
                ? input.afterEventId
                : undefined,
            limit: input.limit ?? 100,
        };
    }
}
export function assertAppScope(resolvedAppId, assertedAppId) {
    const trimmed = assertedAppId?.trim();
    if (trimmed && trimmed !== resolvedAppId) {
        throw new ApplicationError('FORBIDDEN', 'Request appId does not match authenticated app scope');
    }
}
export function normalizeResponseMode(raw, fallback) {
    return raw === 'webhook' || raw === 'both' || raw === 'none' || raw === 'sse'
        ? raw
        : fallback;
}
export function makeAppGroup(input) {
    const app = sanitizeSegment(input.appId) || 'app';
    const conversation = sanitizeSegment(input.conversationId) || 'session';
    const prefix = `app_${input.identityHash}_`;
    const remaining = 96 - prefix.length;
    const appPart = app.slice(0, Math.max(8, Math.floor(remaining * 0.4)));
    const conversationPart = conversation.slice(0, Math.max(8, remaining - appPart.length - 1));
    return {
        name: `${input.appId}:${input.conversationId}`,
        folder: `${prefix}${appPart}_${conversationPart}`.slice(0, 96),
        trigger: '',
        added_at: input.addedAt,
        requiresTrigger: false,
    };
}
export function makeSessionQueueKey(conversationJid, threadId) {
    const normalized = threadId?.trim();
    if (!normalized)
        return conversationJid;
    return `${conversationJid}::thread:${encodeURIComponent(normalized)}`;
}
function sanitizeSegment(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
}
function isVisibleWaitEvent(event) {
    return (event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND ||
        event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING);
}
function hasProviderResumeHandle(value) {
    return (hasNonEmptyString(value.externalSessionId) ||
        hasNonEmptyString(value.providerRef?.value) ||
        metadataContainsResumeHandle(value.metadata, 0));
}
function metadataContainsResumeHandle(value, depth) {
    if (depth > 4 || value == null)
        return false;
    if (Array.isArray(value)) {
        return value.some((entry) => metadataContainsResumeHandle(entry, depth + 1));
    }
    if (typeof value !== 'object')
        return false;
    for (const [key, entry] of Object.entries(value)) {
        if (/(externalSessionId|providerSessionId|latestProviderSessionId|newSessionId|sessionId|session_id|resume|artifact)/i.test(key) &&
            hasNonEmptyString(entry)) {
            return true;
        }
        if (metadataContainsResumeHandle(entry, depth + 1)) {
            return true;
        }
    }
    return false;
}
function hasNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
