export interface TeamsSetupCredentials {
    clientId: string;
    clientSecret: string;
    tenantId: string;
}
export interface TeamsCredentialValidation {
    ok: boolean;
    message: string;
    nextAction?: string;
}
export interface TeamsDiscoveredChannel {
    chatJid: string;
    chatTitle: string;
    teamId: string;
    teamName: string;
    channelId: string;
    channelName: string;
    channelType: string;
    isArchived?: boolean;
}
export interface TeamsChannelDiscoveryResult {
    ok: boolean;
    channels: TeamsDiscoveredChannel[];
    message: string;
    nextAction?: string;
}
export interface TeamsChannelAccessValidation {
    ok: boolean;
    chatJid?: string;
    chatTitle?: string;
    teamId?: string;
    teamName?: string;
    channelId?: string;
    channelName?: string;
    channelType?: string;
    message: string;
    nextAction?: string;
}
export interface TeamsSetupDiscoveryClient {
    validateCredentials(credentials: TeamsSetupCredentials): Promise<TeamsCredentialValidation>;
    listChannels(options: {
        credentials: TeamsSetupCredentials;
        limit?: number;
        includeArchived?: boolean;
    }): Promise<TeamsChannelDiscoveryResult>;
    verifyChannel(options: {
        credentials: TeamsSetupCredentials;
        teamId: string;
        channelId: string;
    }): Promise<TeamsChannelAccessValidation>;
}
export declare function trimTeamsSetupCredentials(credentials: TeamsSetupCredentials): TeamsSetupCredentials;
export declare class GraphTeamsSetupDiscoveryClient implements TeamsSetupDiscoveryClient {
    validateCredentials(credentials: TeamsSetupCredentials): Promise<TeamsCredentialValidation>;
    listChannels(options: {
        credentials: TeamsSetupCredentials;
        limit?: number;
        includeArchived?: boolean;
    }): Promise<TeamsChannelDiscoveryResult>;
    verifyChannel(options: {
        credentials: TeamsSetupCredentials;
        teamId: string;
        channelId: string;
    }): Promise<TeamsChannelAccessValidation>;
}
export declare function validateTeamsAppCredentials(credentials: TeamsSetupCredentials): Promise<TeamsCredentialValidation>;
export declare function listTeamsChannels(options: {
    credentials: TeamsSetupCredentials;
    timeoutMs?: number;
    limit?: number;
    includeArchived?: boolean;
}): Promise<TeamsChannelDiscoveryResult>;
export declare function verifyTeamsChannelAccess(options: {
    credentials: TeamsSetupCredentials;
    teamId: string;
    channelId: string;
    timeoutMs?: number;
}): Promise<TeamsChannelAccessValidation>;
