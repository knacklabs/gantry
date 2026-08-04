import { randomUUID } from 'node:crypto';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { formatOutboundForChannel } from '../../messaging/router.js';
import { nowIso } from '../../shared/time/datetime.js';
import { canonicalConversationIdForJid, canonicalThreadIdFor, } from './runtime-services-destination-hints.js';
export function createConversationOutboundProjection(input) {
    const formatted = formatOutboundForChannel(input.rawText, input.providerId);
    if (!formatted)
        return undefined;
    const now = nowIso();
    const messageId = `outbound:${randomUUID()}`;
    const baseMessage = {
        id: messageId,
        chat_jid: input.conversationJid,
        provider: input.providerId,
        providerAccountId: input.providerAccountId,
        sender: 'gantry',
        sender_name: 'Gantry',
        content: formatted,
        timestamp: now,
        is_from_me: true,
        is_bot_message: true,
        thread_id: input.threadId,
    };
    return {
        formatted,
        provider: input.providerId || input.channelName,
        messageId,
        baseMessage,
        publishEvent: async (eventInput) => {
            if (!input.publishRuntimeEvent)
                return;
            try {
                await input.publishRuntimeEvent({
                    appId: input.appId,
                    conversationId: input.conversationJid,
                    ...(input.threadId ? { threadId: input.threadId } : {}),
                    eventType: RUNTIME_EVENT_TYPES.CONVERSATION_MESSAGE_OUTBOUND,
                    actor: 'agent',
                    responseMode: 'none',
                    payload: {
                        messageId,
                        conversationId: canonicalConversationIdForJid(input.conversationJid, input.providerAccountId),
                        threadId: canonicalThreadIdFor({
                            jid: input.conversationJid,
                            threadId: input.threadId,
                            providerAccountId: input.providerAccountId,
                        }) ?? null,
                        direction: 'outbound',
                        deliveryStatus: eventInput.deliveryStatus,
                        sender: {
                            id: baseMessage.sender,
                            name: baseMessage.sender_name,
                        },
                        ...(eventInput.externalMessageId
                            ? { externalMessageId: eventInput.externalMessageId }
                            : {}),
                        ...(eventInput.error ? { error: eventInput.error } : {}),
                        text: formatted,
                    },
                    createdAt: nowIso(),
                });
            }
            catch (err) {
                input.logger.warn({ err, jid: input.conversationJid }, 'Failed to publish conversation outbound runtime event');
            }
        },
    };
}
