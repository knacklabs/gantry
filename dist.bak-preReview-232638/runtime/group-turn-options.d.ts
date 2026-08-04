import type { MessageSendOptions, ProgressUpdateOptions, StreamingChunkOptions } from '../domain/types.js';
export declare function createGroupTurnOptionBuilders(input: {
    activeThreadId?: string;
    providerAccountId?: string;
    streamGeneration: () => number;
    progressGeneration: () => number;
}): {
    buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
    buildStreamingOptions: (args: {
        threadId?: string;
        done?: boolean;
    }) => StreamingChunkOptions;
    liveStopActionToken: string;
    buildProgressOptions: (args?: {
        threadId?: string;
        done?: boolean;
        replaceOnly?: boolean;
    }) => ProgressUpdateOptions;
};
