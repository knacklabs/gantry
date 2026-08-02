export interface RetryTailProviderPayload {
    provider?: string;
    channelId?: string;
    chatId?: string;
    chatJid?: string;
    conversationId?: string;
    conversationJid?: string;
    jid?: string;
    threadId?: string;
    externalMessageId?: string;
    externalMessageIds?: string[];
    deliveredParts?: number;
    totalParts?: number;
    warnings?: string[];
    fallbackArtifactId?: string;
}
export declare function sanitizeRetryTailProviderPayload(payload: unknown): RetryTailProviderPayload | undefined;
