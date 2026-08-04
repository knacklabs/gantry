export interface DiscordSetupCredentials {
    botToken: string;
    applicationId: string;
}
export interface DiscordCredentialValidation {
    ok: boolean;
    message: string;
    nextAction?: string;
}
export interface DiscordDiscoveredChannel {
    chatJid: string;
    chatTitle: string;
    guildId: string;
    guildName: string;
    channelId: string;
    channelName: string;
    channelType: string;
}
export interface DiscordChannelDiscoveryResult {
    ok: boolean;
    channels: DiscordDiscoveredChannel[];
    message: string;
    nextAction?: string;
}
export interface DiscordChannelAccessValidation {
    ok: boolean;
    chatJid?: string;
    chatTitle?: string;
    guildId?: string;
    guildName?: string;
    channelId?: string;
    channelName?: string;
    channelType?: string;
    message: string;
    nextAction?: string;
}
export interface DiscordSetupDiscoveryClient {
    validateCredentials(credentials: DiscordSetupCredentials): Promise<DiscordCredentialValidation>;
    listChannels(options: {
        credentials: DiscordSetupCredentials;
        limit?: number;
    }): Promise<DiscordChannelDiscoveryResult>;
    verifyChannel(options: {
        credentials: DiscordSetupCredentials;
        guildId: string;
        channelId: string;
    }): Promise<DiscordChannelAccessValidation>;
    registerGantryCommand(options: {
        credentials: DiscordSetupCredentials;
        guildId: string;
    }): Promise<DiscordCredentialValidation>;
}
export declare function trimDiscordSetupCredentials(credentials: DiscordSetupCredentials): DiscordSetupCredentials;
export declare class RestDiscordSetupDiscoveryClient implements DiscordSetupDiscoveryClient {
    validateCredentials(credentials: DiscordSetupCredentials): Promise<DiscordCredentialValidation>;
    listChannels(options: {
        credentials: DiscordSetupCredentials;
        limit?: number;
    }): Promise<DiscordChannelDiscoveryResult>;
    verifyChannel(options: {
        credentials: DiscordSetupCredentials;
        guildId: string;
        channelId: string;
    }): Promise<DiscordChannelAccessValidation>;
    registerGantryCommand(options: {
        credentials: DiscordSetupCredentials;
        guildId: string;
    }): Promise<DiscordCredentialValidation>;
}
export declare function validateDiscordCredentials(credentials: DiscordSetupCredentials): Promise<DiscordCredentialValidation>;
export declare function listDiscordChannels(options: {
    credentials: DiscordSetupCredentials;
    limit?: number;
}): Promise<DiscordChannelDiscoveryResult>;
export declare function verifyDiscordChannelAccess(options: {
    credentials: DiscordSetupCredentials;
    guildId: string;
    channelId: string;
}): Promise<DiscordChannelAccessValidation>;
export declare function registerDiscordGantryCommand(options: {
    credentials: DiscordSetupCredentials;
    guildId: string;
}): Promise<DiscordCredentialValidation>;
