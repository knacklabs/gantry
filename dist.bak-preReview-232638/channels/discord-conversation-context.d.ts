import type { NewMessage } from '../domain/types.js';
import type { ConversationContextHydrationRequest, ConversationContextHydrationResult } from './channel-provider.js';
import type { DiscordMessageCreate } from './discord-types.js';
export type DiscordConversationContextCache = Map<string, {
    conversationJid: string;
    threadId?: string;
}>;
export type DiscordContextRequestJson = <T>(path: string, init: RequestInit, errorMessage: string, parseJson?: boolean) => Promise<T>;
export declare function hydrateDiscordConversationContext(input: {
    request: ConversationContextHydrationRequest;
    botToken: string;
    botUserId: string | null;
    cache: DiscordConversationContextCache;
    headers(token: string): Record<string, string>;
    requestJson: DiscordContextRequestJson;
}): Promise<ConversationContextHydrationResult>;
export declare function resolveDiscordConversationContext(input: {
    channelId: string;
    botToken: string;
    cache: DiscordConversationContextCache;
    headers(token: string): Record<string, string>;
    requestJson: DiscordContextRequestJson;
}): Promise<{
    conversationJid: string;
    threadId?: string;
}>;
export declare function discordMessageAttachments(message: DiscordMessageCreate): NonNullable<NewMessage['attachments']>;
