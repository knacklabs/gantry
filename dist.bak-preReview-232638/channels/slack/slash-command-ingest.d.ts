import type { ChannelOpts } from '../channel-provider.js';
type SlackSlashCommandOpts = Pick<ChannelOpts, 'onMessage' | 'onChatMetadata' | 'conversationRoutes' | 'providerAccountId' | 'inboundProviderAccountIds'>;
export declare function ingestSlackSlashCommand(input: {
    command: {
        channel_id?: string;
        user_id?: string;
        user_name?: string;
        text?: string;
        trigger_id?: string;
        command_id?: string;
    };
    opts: SlackSlashCommandOpts;
    resolveChannelName(channelId: string): Promise<string | undefined>;
    resolveUserName(userId?: string): Promise<string>;
    isLikelyGroupConversation(channelId: string): boolean;
}): Promise<void>;
export {};
