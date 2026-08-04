import type { ConversationRoute } from '../domain/types.js';
export declare function resolveRunnerIpcRoute(input: {
    routes: Record<string, ConversationRoute>;
    sourceAgentFolder: string;
    targetJid?: string;
    threadId?: string;
    providerAccountId?: string;
}): {
    targetJid: string;
    conversationId?: string;
    providerAccountId?: string;
};
