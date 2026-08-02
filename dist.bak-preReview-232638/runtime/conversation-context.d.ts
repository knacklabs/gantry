import type { NewMessage } from '../domain/types.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
export declare const CONVERSATION_CONTEXT_LIMITS: {
    readonly channelMessages: 30;
    readonly threadMessages: 50;
};
export interface ConversationContextPacket {
    recentChannelContext: NewMessage[];
    activeThreadContext: NewMessage[];
    currentMessages: NewMessage[];
    metadata: {
        recentChannelCount: number;
        activeThreadCount: number;
        currentMessageCount: number;
        activeThreadId: string | null;
        recentChannelWindowComplete: boolean;
        activeThreadWindowComplete: boolean;
        activeThreadRootPresent: boolean;
    };
}
export declare function buildConversationContextPacket(input: {
    conversationJid: string;
    providerAccountId?: string | null;
    activeThreadId?: string | null;
    latestMessage: NewMessage;
    currentMessages: NewMessage[];
    repository: Pick<RuntimeMessageRepository, 'getRecentTopLevelMessagesBefore' | 'getFirstThreadMessages' | 'getLatestThreadMessages'>;
}): Promise<ConversationContextPacket>;
