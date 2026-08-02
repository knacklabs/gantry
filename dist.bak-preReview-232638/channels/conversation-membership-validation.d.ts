import type { ConversationMembershipValidationInput, ConversationMembershipValidationResult, ConversationMembershipValidator } from '../application/provider-conversations/conversation-administration-service.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
export declare const DISCORD_RUNTIME_CHANNEL_PERMISSION_BITS: bigint;
export declare function discordMemberHasChannelPermissions(input: {
    guildId: string;
    userId: string;
    memberRoles: string[];
    roles: Array<{
        id?: string;
        permissions?: string;
    }>;
    overwrites: Array<{
        id?: string;
        type?: number;
        allow?: string;
        deny?: string;
    }>;
    requiredPermissions?: bigint;
}): boolean;
export declare class RuntimeSecretConversationMembershipValidator implements ConversationMembershipValidator {
    private readonly secrets;
    constructor(secrets: RuntimeSecretProvider);
    validateControlApprovers(input: ConversationMembershipValidationInput): Promise<ConversationMembershipValidationResult>;
    private validateTelegram;
    private validateSlack;
    private listSlackMembers;
    private validateDiscord;
    private validateTeams;
    private fetchTeamsGraphToken;
    private listTeamsMembers;
    private resolveSecret;
}
