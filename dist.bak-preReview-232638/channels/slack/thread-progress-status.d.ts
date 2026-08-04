import type { ProgressUpdateOptions } from '../../domain/types.js';
type SlackThreadStatusApp = {
    client: {
        apiCall(method: string, input: Record<string, unknown>): Promise<unknown>;
    };
};
export declare function isSlackTerminalSuccessText(text: string): boolean;
export declare function sendSlackThreadProgressStatus(input: {
    app: SlackThreadStatusApp;
    channelId: string;
    threadTs: string;
    key: string;
    statusText: string;
    options: ProgressUpdateOptions;
}): Promise<boolean>;
export declare function handleSlackThreadProgressStatus(input: {
    app: SlackThreadStatusApp;
    channelId: string;
    key: string;
    text: string;
    options: ProgressUpdateOptions;
    onDone: () => void;
}): Promise<boolean>;
export {};
