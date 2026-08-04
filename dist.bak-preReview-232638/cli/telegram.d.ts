export interface TelegramTokenValidation {
    ok: boolean;
    botId?: number;
    username?: string;
    displayName?: string;
    message: string;
    nextAction?: string;
}
export interface TelegramChatAccessValidation {
    ok: boolean;
    chatTitle?: string;
    sentTestMessage?: boolean;
    message: string;
    nextAction?: string;
}
export declare function normalizeTelegramChatJid(raw: string): string | null;
export declare function validateTelegramBotToken(token: string, timeoutMs?: number): Promise<TelegramTokenValidation>;
export declare function verifyTelegramChatAccess(options: {
    token: string;
    chatJid: string;
    botId?: number;
    sendTestMessage?: boolean;
    timeoutMs?: number;
}): Promise<TelegramChatAccessValidation>;
export declare function registerTelegramMainGroup(options: {
    runtimeHome: string;
    chatJid: string;
    displayName: string;
    agentId?: string;
}): Promise<{
    folder: string;
    groupName: string;
}>;
export declare function readTelegramFromRuntimeEnv(runtimeHome: string): {
    token: string;
};
