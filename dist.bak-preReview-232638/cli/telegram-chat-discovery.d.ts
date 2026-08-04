export interface TelegramRecentChat {
    chatJid: string;
    chatTitle: string;
    chatType: string;
    username?: string;
    lastSenderId?: string;
    lastSenderName?: string;
    sourceUpdateId: number;
}
export interface TelegramRecentChatsResult {
    ok: boolean;
    chats: TelegramRecentChat[];
    message: string;
    nextAction?: string;
}
export declare function listTelegramRecentChats(options: {
    token: string;
    timeoutMs?: number;
    limit?: number;
}): Promise<TelegramRecentChatsResult>;
