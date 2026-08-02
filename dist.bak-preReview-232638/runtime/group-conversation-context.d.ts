import type { NewMessage } from '../domain/types.js';
import type { GroupProcessingDeps, GroupProcessingRepository } from './group-processing-types.js';
export declare function buildGroupTurnConversationContext(input: {
    deps: GroupProcessingDeps;
    repository: GroupProcessingRepository;
    agentFolder: string;
    chatJid: string;
    providerAccountId?: string | null;
    activeThreadId: string | null | undefined;
    latestMessage: NewMessage;
    currentMessages: NewMessage[];
    timezone: string;
}): Promise<{
    prompt: string;
    recallQuery: string | undefined;
    logContext: {
        context: {
            recentChannelCount: number;
            activeThreadCount: number;
            currentMessageCount: number;
            activeThreadId: string | null;
            recentChannelWindowComplete: boolean;
            activeThreadWindowComplete: boolean;
            activeThreadRootPresent: boolean;
        };
        hydration: {
            providerId: string;
            attempted: boolean;
            skipped: boolean;
            failed: boolean;
            messageCount: number;
            storeAttemptedMessageCount: number;
            storedMessageCount: number;
            storeFailedMessageCount: number;
            droppedMessageCount: number;
        } | undefined;
    };
}>;
