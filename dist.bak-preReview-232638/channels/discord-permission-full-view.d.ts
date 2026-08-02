import type { PermissionApprovalRequest } from '../domain/types.js';
import type { PendingDiscordPermission } from './discord-permission-prompt-settlement.js';
import type { DiscordInteraction } from './discord-types.js';
export declare const DISCORD_PERMISSION_FULL_VIEW_PREFIX = "gantry:perm_full:";
export declare function discordPermissionFullViewCustomId(providerAlias: string): string;
export declare function handleDiscordPermissionFullView(input: {
    interaction: DiscordInteraction;
    customId: string;
    appId: string;
    applicationId: string;
    botToken: string;
    timeoutMs: number;
    pendingPermissions: Map<string, PendingDiscordPermission>;
    resolveConversationContext: (channelId: string) => Promise<{
        conversationJid: string;
        threadId?: string;
    }>;
    isApproverAllowed: (userId: string | undefined, sourceAgentFolder: string, decisionPolicy: PermissionApprovalRequest['decisionPolicy'], threadId?: string, conversationJid?: string) => Promise<boolean>;
    acknowledge: (content: string) => Promise<void>;
}): Promise<void>;
