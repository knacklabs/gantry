import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { sha256Base64Url } from '../../shared/stable-hash.js';
import { ApplicationError } from '../common/application-error.js';
export class ConversationMessageIngressModule {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async acceptMessage(input) {
        const text = input.message.trim();
        if (!text) {
            throw new ApplicationError('INVALID_REQUEST', 'message is required');
        }
        const conversation = await this.requireConversation({
            appId: input.appId,
            conversationId: input.conversationId,
        });
        const conversationJid = resolveConversationJid(conversation, await this.resolveProviderJidPrefix(conversation));
        if (!conversationJid) {
            throw new ApplicationError('NOT_FOUND', 'Conversation is not configured for runtime routing');
        }
        const thread = await this.resolveThreadRouting({
            appId: input.appId,
            conversation,
            conversationJid,
            threadId: input.threadId ?? null,
        });
        const publicThreadId = thread.publicThreadId;
        const runtimeThreadId = thread.runtimeThreadId;
        if (!this.deps.isConversationRoutable(conversationJid, runtimeThreadId, conversation.providerAccountId)) {
            throw new ApplicationError('NOT_FOUND', 'Conversation is not configured for runtime routing');
        }
        const route = await this.resolveRoute({
            conversationJid,
            threadId: runtimeThreadId,
            agentId: input.agentId ?? null,
            providerAccountId: conversation.providerAccountId,
        });
        const now = this.deps.now();
        const senderId = input.senderId?.trim() || 'external-ingress';
        const senderName = input.senderName?.trim() || 'External System';
        const provider = this.deps.providerForConversationJid(conversationJid);
        const externalMessageId = input.messageRef?.trim() || `external-ingress:${input.invocationId}`;
        const messageId = input.messageRef?.trim()
            ? stableExternalIngressMessageId([
                input.appId,
                conversation.id,
                publicThreadId ?? '',
                externalMessageId,
            ])
            : this.deps.createId();
        const message = {
            id: messageId,
            chat_jid: conversationJid,
            provider,
            providerAccountId: conversation.providerAccountId,
            sender: senderId,
            sender_name: senderName,
            content: text,
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
            external_message_id: externalMessageId,
            thread_id: runtimeThreadId ?? undefined,
        };
        await this.deps.ops.storeChatMetadata(conversationJid, now, conversation.title ?? conversationJid, provider, conversation.kind === 'group' || conversation.kind === 'channel', { providerAccountId: conversation.providerAccountId });
        const acceptedEvent = {
            appId: input.appId,
            conversationId: conversation.id,
            threadId: publicThreadId ?? undefined,
            eventType: RUNTIME_EVENT_TYPES.CONVERSATION_MESSAGE_INBOUND,
            actor: senderId,
            correlationId: input.correlationId ?? null,
            responseMode: 'none',
            payload: {
                messageId,
                conversationId: conversation.id,
                threadId: publicThreadId,
                direction: 'inbound',
                deliveryStatus: 'accepted',
                sender: {
                    id: senderId,
                    name: senderName,
                },
                text,
            },
            createdAt: now,
        };
        let durableAdmissionCreated = false;
        let admissionResult;
        let accepted;
        if (this.deps.runtimeEvents.publishWithLiveAdmissionMessage &&
            this.deps.liveAdmissionAppId !== null) {
            const liveAdmissionAppId = this.deps.liveAdmissionAppId ?? input.appId;
            const result = await this.deps.runtimeEvents.publishWithLiveAdmissionMessage(acceptedEvent, {
                message,
                liveAdmission: {
                    appId: liveAdmissionAppId,
                    ...(route.agentId ? { agentId: route.agentId } : {}),
                    providerAccountId: conversation.providerAccountId,
                    triggerDecision: {
                        source: 'external_ingress',
                        conversationKind: conversation.kind,
                    },
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
        const messageRef = input.messageRef?.trim();
        if (messageRef) {
            await this.deps.messageReactions
                ?.addReaction(conversationJid, messageRef, 'seen', {
                providerAccountId: conversation.providerAccountId,
            })
                .catch(() => undefined);
        }
        return {
            messageId,
            conversationId: conversation.id,
            threadId: publicThreadId,
            acceptedEventId: accepted.eventId,
            enqueue: {
                conversationJid,
                threadId: runtimeThreadId,
                providerAccountId: conversation.providerAccountId,
                queueKey: route.queueKey,
                durableAdmissionCreated,
            },
        };
    }
    async resolveRoute(input) {
        const route = await this.deps.resolveRoute?.(input);
        if (route)
            return route;
        if (this.deps.resolveRoute) {
            throw new ApplicationError('NOT_FOUND', 'Conversation is not configured for runtime routing');
        }
        return {
            agentId: input.agentId ?? null,
            queueKey: this.deps.makeQueueKey(input.conversationJid, input.threadId),
        };
    }
    async requireConversation(input) {
        const conversation = await this.deps.conversations.getConversation(input.conversationId);
        if (!conversation) {
            throw new ApplicationError('NOT_FOUND', 'Conversation not found');
        }
        if (conversation.appId !== input.appId) {
            throw new ApplicationError('FORBIDDEN', 'Ingress cannot access this conversation');
        }
        if (conversation.status !== 'active') {
            throw new ApplicationError('CONFLICT', 'Conversation is not active');
        }
        return conversation;
    }
    async resolveThreadRouting(input) {
        if (!input.threadId) {
            return { publicThreadId: null, runtimeThreadId: null };
        }
        const thread = await this.deps.conversations.getThread(input.threadId);
        if (!thread) {
            const runtimeThreadId = resolveRuntimeThreadIdFromCanonical(input.threadId, input.conversationJid, input.conversation.providerAccountId);
            if (runtimeThreadId) {
                return {
                    publicThreadId: input.threadId,
                    runtimeThreadId,
                };
            }
            throw new ApplicationError('NOT_FOUND', 'Conversation thread not found');
        }
        if (thread.appId !== input.appId ||
            thread.conversationId !== input.conversation.id) {
            throw new ApplicationError('NOT_FOUND', 'Conversation thread not found');
        }
        if (thread.status !== 'active') {
            throw new ApplicationError('CONFLICT', 'Conversation thread is not active');
        }
        if (!resolveRuntimeThreadId(thread)) {
            throw new ApplicationError('NOT_FOUND', 'Conversation thread is not configured for runtime routing');
        }
        return {
            publicThreadId: thread.id,
            runtimeThreadId: resolveRuntimeThreadId(thread),
        };
    }
    async resolveProviderJidPrefix(conversation) {
        const refValue = conversation.externalRef?.value?.trim();
        if (refValue?.includes(':'))
            return null;
        if (!this.deps.resolveProviderJidPrefix)
            return null;
        return await this.deps.resolveProviderJidPrefix(conversation.providerAccountId);
    }
}
function resolveConversationJid(conversation, providerJidPrefix) {
    const refValue = conversation.externalRef?.value?.trim();
    if (refValue?.includes(':'))
        return refValue;
    if (conversation.id.startsWith('conversation:')) {
        const scopedPrefix = `conversation:${conversation.providerAccountId}:`;
        const jid = conversation.id.startsWith(scopedPrefix)
            ? conversation.id.slice(scopedPrefix.length).trim()
            : conversation.id.slice('conversation:'.length).trim();
        if (jid && providerJidPrefix && !jid.includes(':')) {
            return `${providerJidPrefix}${jid}`;
        }
        if (jid)
            return jid;
    }
    if (refValue && providerJidPrefix)
        return `${providerJidPrefix}${refValue}`;
    return refValue?.includes(':') ? refValue : null;
}
function resolveRuntimeThreadId(thread) {
    const refValue = thread.externalRef?.value?.trim();
    if (refValue)
        return refValue;
    const conversationId = thread.conversationId;
    if (!conversationId.startsWith('conversation:'))
        return null;
    const conversationJid = conversationId.slice('conversation:'.length).trim();
    const prefix = `thread:${conversationJid}:`;
    return thread.id.startsWith(prefix) ? thread.id.slice(prefix.length) : null;
}
function resolveRuntimeThreadIdFromCanonical(threadId, conversationJid, providerAccountId) {
    for (const prefix of [
        `thread:${conversationJid}:`,
        `thread:${providerAccountId}:${conversationJid}:`,
    ]) {
        if (!threadId.startsWith(prefix))
            continue;
        const runtimeThreadId = threadId.slice(prefix.length).trim();
        return runtimeThreadId ? runtimeThreadId : null;
    }
    return null;
}
function stableExternalIngressMessageId(parts) {
    return `external-ingress:${sha256Base64Url(parts.join('\0')).slice(0, 32)}`;
}
