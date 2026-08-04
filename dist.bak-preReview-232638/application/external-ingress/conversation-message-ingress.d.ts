import type { NewMessage } from '../../domain/types.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type { RuntimeEvent, RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { RuntimeChatMetadataRepository, RuntimeMessageRepository } from '../../domain/repositories/ops-repo.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../domain/ports/live-turns.js';
export type ConversationMessageQueueIntent = {
    conversationJid: string;
    threadId: string | null;
    providerAccountId: string;
    queueKey: string;
    durableAdmissionCreated: boolean;
};
type ConversationMessageRouteResolution = {
    agentId?: string | null;
    queueKey: string;
};
export declare class ConversationMessageIngressModule {
    private readonly deps;
    constructor(deps: {
        conversations: ConversationRepository;
        ops: RuntimeChatMetadataRepository & RuntimeMessageRepository;
        runtimeEvents: {
            publish(input: RuntimeEventPublishInput): Promise<{
                eventId: number;
            }>;
            publishWithLiveAdmissionMessage?(input: RuntimeEventPublishInput, admission: {
                message: NewMessage;
                liveAdmission: {
                    appId: string;
                    agentId?: string | null;
                    agentSessionId?: string | null;
                    providerAccountId?: string | null;
                    triggerDecision?: Record<string, unknown>;
                    now?: string;
                };
            }): Promise<{
                event: RuntimeEvent;
                liveAdmissionResult: LiveAdmissionWorkItemEnqueueResult | undefined;
            }>;
        };
        messageReactions?: {
            addReaction(jid: string, messageRef: string, emoji: string, options?: {
                providerAccountId?: string;
            }): Promise<void>;
        };
        liveAdmissionAppId?: string | null;
        isConversationRoutable: (conversationJid: string, threadId?: string | null, providerAccountId?: string | null) => boolean;
        resolveProviderJidPrefix?: (providerAccountId: string) => Promise<string | null>;
        providerForConversationJid: (conversationJid: string) => string;
        makeQueueKey: (conversationJid: string, threadId: string | null) => string;
        resolveRoute?: (input: {
            conversationJid: string;
            threadId: string | null;
            agentId?: string | null;
            providerAccountId?: string | null;
        }) => ConversationMessageRouteResolution | null | Promise<ConversationMessageRouteResolution | null>;
        now: () => string;
        createId: () => string;
    });
    acceptMessage(input: {
        appId: string;
        invocationId: string;
        conversationId: string;
        threadId?: string | null;
        agentId?: string | null;
        message: string;
        senderId?: string | null;
        senderName?: string | null;
        messageRef?: string | null;
        correlationId?: string | null;
    }): Promise<{
        messageId: string;
        conversationId: string;
        threadId: string | null;
        acceptedEventId: number;
        enqueue: ConversationMessageQueueIntent;
    }>;
    private resolveRoute;
    private requireConversation;
    private resolveThreadRouting;
    private resolveProviderJidPrefix;
}
export {};
