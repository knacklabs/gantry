import '../channels/register-builtins.js';
export interface SlackTokenValidation {
    ok: boolean;
    teamId?: string;
    teamName?: string;
    userId?: string;
    message: string;
    nextAction?: string;
}
export interface SlackAppTokenValidation {
    ok: boolean;
    message: string;
    nextAction?: string;
}
export interface SlackChatAccessValidation {
    ok: boolean;
    chatTitle?: string;
    sentTestMessage?: boolean;
    message: string;
    nextAction?: string;
}
export declare function normalizeSlackChatJid(raw: string): string | null;
export declare function validateSlackBotToken(token: string, timeoutMs?: number): Promise<SlackTokenValidation>;
export declare function validateSlackAppToken(appToken: string, timeoutMs?: number): Promise<SlackAppTokenValidation>;
export declare function verifySlackChatAccess(options: {
    botToken: string;
    chatJid: string;
    sendTestMessage?: boolean;
    timeoutMs?: number;
}): Promise<SlackChatAccessValidation>;
export declare function registerSlackMainGroup(options: {
    runtimeHome: string;
    chatJid: string;
    displayName: string;
    conversationDisplayName?: string;
    approverIds?: string[];
    agentId?: string;
}): Promise<{
    folder: string;
    groupName: string;
}>;
export declare function runSlackConnectCommand(runtimeHome: string, requestedAgentId?: string, requestedAgentName?: string): Promise<number>;
