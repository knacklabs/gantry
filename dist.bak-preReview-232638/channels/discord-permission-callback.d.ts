import type { PermissionApprovalRequest } from '../domain/types.js';
import type { DiscordInteraction } from './discord-types.js';
import { type PendingDiscordPermission } from './discord-permission-prompt-settlement.js';
type DiscordConversationContext = {
    conversationJid: string;
    threadId?: string;
};
export declare function handleDiscordPermissionCallback(input: {
    appId: string;
    interaction: DiscordInteraction;
    customId: string;
    pendingPermissions: Map<string, PendingDiscordPermission>;
    botToken: string;
    ack: (content: string) => Promise<void>;
    feedback: (content: string) => Promise<void>;
    resolveConversationContext: (channelId: string) => Promise<DiscordConversationContext>;
    isApproverAllowed: (userId: string | undefined, sourceAgentFolder: string, decisionPolicy: PermissionApprovalRequest['decisionPolicy'], threadId?: string, conversationJid?: string) => Promise<boolean>;
}): Promise<void>;
export {};
