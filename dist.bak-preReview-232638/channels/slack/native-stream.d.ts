import type { App } from '@slack/bolt';
export declare function tryNativeStreamStart(input: {
    app: App | null;
    channelId: string;
    threadId: string | undefined;
    text: string;
}): Promise<string | undefined>;
export declare function tryNativeStreamAppend(input: {
    app: App | null;
    channelId: string;
    streamTs: string;
    text: string;
}): Promise<{
    completed: boolean;
    sentPrefix: string;
}>;
export declare function tryNativeStreamStop(input: {
    app: App | null;
    channelId: string;
    streamTs: string;
}): Promise<boolean>;
