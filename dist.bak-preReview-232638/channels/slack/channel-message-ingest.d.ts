import type { ChannelOpts } from '../channel-provider.js';
import type { NewMessage } from '../../domain/types.js';
import type { SlackMessageLike } from './channel-state.js';
type SlackIngestOpts = Pick<ChannelOpts, 'onMessage' | 'onChatMetadata' | 'conversationRoutes' | 'providerAccountId' | 'inboundProviderAccountIds'>;
type EnrichedSlackMessage = {
    text: string;
    attachments: NonNullable<NewMessage['attachments']>;
};
export declare function ingestSlackSlashCommand(input: {
    command: {
        channel_id?: string;
        user_id?: string;
        user_name?: string;
        text?: string;
        trigger_id?: string;
        command_id?: string;
    };
    opts: SlackIngestOpts;
    resolveChannelName: (channelId: string) => Promise<string>;
    resolveUserName: (userId?: string) => Promise<string>;
    isLikelyGroupConversation: (channelId: string) => boolean;
}): Promise<void>;
export declare function ingestSlackMessage(input: {
    event: SlackMessageLike;
    options?: {
        forceOwnedTopLevel?: boolean;
    };
    opts: SlackIngestOpts;
    botUserId: string | null;
    resolveChannelName: (channelId: string) => Promise<string>;
    resolveUserName: (userId?: string) => Promise<string>;
    isLikelyGroupConversation: (channelId: string) => boolean;
    enrichMessage: (jid: string, event: SlackMessageLike, targetFolder?: string) => Promise<EnrichedSlackMessage>;
}): Promise<void>;
export {};
