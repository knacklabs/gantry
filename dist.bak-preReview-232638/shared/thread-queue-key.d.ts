export declare function normalizeThreadQueueId(threadId?: string | null): string | undefined;
export declare function makeThreadQueueKey(chatJid: string, threadId?: string | null): string;
export declare function makeAgentThreadQueueKey(chatJid: string, agentId?: string | null, threadId?: string | null, providerAccountId?: string | null): string;
export declare function parseThreadQueueKey(queueJid: string): {
    chatJid: string;
    threadId?: string;
};
export declare function parseAgentThreadQueueKey(queueJid: string): {
    chatJid: string;
    threadId?: string;
    agentId?: string;
    providerAccountId?: string;
};
export declare function findConversationRoutesForChat<T>(routes: Record<string, T>, chatJid: string, threadId?: string | null, providerAccountId?: string | null): Array<[string, T]>;
export declare function findSingleConversationRouteForChat<T>(routes: Record<string, T>, chatJid: string, threadId?: string | null): T | undefined;
export declare function routesForConversationId<T extends {
    conversationId?: string;
}>(routes: Record<string, T>, conversationId: string | null | undefined): Record<string, T>;
export declare function findConversationRouteForQueue<T>(routes: Record<string, T>, queueJid: string, agentIdForRoute: (route: T) => string): T | undefined;
export declare function firstThreadQueueId(...threadIds: Array<string | null | undefined>): string | undefined;
