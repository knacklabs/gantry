export declare const RETRY_TAIL_PROFILE_ID = "runtime.retry_tail_suffix.v1";
export declare const LIVE_SEND_PROFILE_ID = "runtime.live_send.v1";
export declare function canonicalConversationIdForJid(jid: string, providerAccountId?: string): string;
export declare function resolveDurableOutboundTarget(input: {
    defaultAppId: string;
    jid: string;
    providerAccountId?: string;
}): {
    appId: string;
    conversationId: string;
};
export declare function canonicalThreadIdFor(input: {
    jid: string;
    threadId?: string;
    providerAccountId?: string;
}): string | undefined;
export declare function normalizeDestinationHintAgainstCanonical(rawHint: unknown, canonicalConversationJid: string): {
    providerJid?: string;
    malformedCanonicalHint: boolean;
};
export declare function sanitizeRetryTailProviderPayloadDestinationMetadata(providerPayload: unknown, canonicalConversationJid: string): Record<string, unknown> | undefined;
export declare function sanitizeRetryTailForCanonicalDestination(retryTail: {
    canonicalText: string;
    providerPayload?: unknown;
} | undefined, canonicalConversationJid: string): {
    canonicalText: string;
    providerPayload?: Record<string, unknown>;
} | undefined;
