import type { ChannelWiring } from './channel-wiring-types.js';
import type { ConversationRoute } from '../../domain/types.js';
export declare function registerRuntimeLiveStopMessageAction(channelWiring: ChannelWiring, app: {
    getConversationRoutes(): Record<string, ConversationRoute>;
}, liveMessageQueue: {
    stopGroup: (queueJid: string) => boolean | Promise<boolean>;
}, scheduler?: {
    runNow: (input: {
        jobId: string;
        sourceAgentFolder: string;
        originConversationJid: string;
        authThreadId?: string;
        conversationBindings: Record<string, ConversationRoute>;
        sourceConversationJids: string[];
    }) => Promise<string>;
}): void;
export declare function registerLiveStopMessageAction(input: {
    channelWiring: ChannelWiring;
    sourceAgentFolderFor: (conversationJid: string, threadId?: string, providerAccountId?: string) => string | undefined;
    conversationBindings?: () => Record<string, ConversationRoute>;
    stopGroup: (queueJid: string) => boolean | Promise<boolean>;
    runSchedulerNow?: (schedulerInput: {
        jobId: string;
        sourceAgentFolder: string;
        originConversationJid: string;
        authThreadId?: string;
        conversationBindings: Record<string, ConversationRoute>;
        sourceConversationJids: string[];
    }) => Promise<string>;
}): void;
