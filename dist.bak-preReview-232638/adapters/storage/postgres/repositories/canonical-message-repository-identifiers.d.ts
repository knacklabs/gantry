import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
export declare function messageIdFor(chatJid: string, id: string, providerAccountId?: string | null): string;
export declare function publicThreadIdForRow(chatJid: string, threadId: string, externalRefJson: string | null): string;
export declare function liveAdmissionWorkItemId(appId: string, canonicalMessageId: string, providerAccountId?: string | null, agentId?: string | null): string;
export declare function liveAdmissionIdempotencyKey(msg: NewMessage, appId: string, providerId: string, providerAccountId?: string | null, agentId?: string | null): string;
export declare function externalRefForMessage(msg: NewMessage): {
    kind: string;
    id: string;
    chat_jid: string;
    provider: string | undefined;
    provider_account_id: string | undefined;
    thread_id: string | undefined;
    external_message_id: string | undefined;
    reply_to_message_id: string | undefined;
    reply_to_sender_name: string | undefined;
    response_schema: Record<string, unknown> | undefined;
    effort: import("../../../../domain/types.js").AgentControlEffort | undefined;
    thinking: import("../../../../domain/types.js").AgentControlThinking | undefined;
    max_output_tokens: number | undefined;
    delivery_retry_tail: {
        providerPayload?: import("../../../../domain/messages/retry-tail-provider-payload.js").RetryTailProviderPayload | undefined;
        canonicalText: string;
    } | undefined;
};
