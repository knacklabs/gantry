import type { App } from '@slack/bolt';
import type { MessageFileAttachment } from '../../domain/types.js';
type SlackPostMessagePayload = {
    channel: string;
    text: string;
    thread_ts?: string;
};
type SlackDeliveryLogger = {
    warn(metadata: Record<string, unknown>, message: string): void;
};
type PostSlackMessageWithRetry = (app: App | null, payload: SlackPostMessagePayload, context: {
    jid: string;
    part: number;
    totalParts: number;
}, warnings: string[], log: SlackDeliveryLogger) => Promise<{
    ts?: string;
}>;
export declare function uploadSlackAttachments(input: {
    app: App;
    jid: string;
    channelId: string;
    threadTs?: string;
    files?: MessageFileAttachment[];
    warnings: string[];
    externalMessageIds: string[];
    log: SlackDeliveryLogger;
    postSlackMessageWithRetry: PostSlackMessageWithRetry;
}): Promise<void>;
export {};
