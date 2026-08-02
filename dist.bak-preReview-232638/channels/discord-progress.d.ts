import type { MessageDeliveryResult, ProgressUpdateOptions } from '../domain/types.js';
export type DiscordProgressPost = (text: string, components?: unknown[]) => Promise<MessageDeliveryResult>;
export type DiscordProgressEdit = (messageId: string, body: Record<string, unknown>) => Promise<void>;
export declare function sendDiscordProgressUpdate(input: {
    key: string;
    activeMessages: Map<string, string>;
    text: string;
    options: ProgressUpdateOptions;
    post: DiscordProgressPost;
    edit: DiscordProgressEdit;
}): Promise<void>;
