import type { NewMessage } from '../domain/types.js';
import type { GroupProcessingDeps, GroupProcessingRepository } from './group-processing-types.js';
export declare function buildGroupProcessingConversationContext(input: {
    deps: GroupProcessingDeps;
    repository: GroupProcessingRepository;
    groupName: string;
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
}>;
