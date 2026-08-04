export interface SlackRecentChat {
    chatJid: string;
    chatTitle: string;
    chatType: string;
    isArchived?: boolean;
    sourceTs: number;
}
export interface SlackRecentChatsResult {
    ok: boolean;
    chats: SlackRecentChat[];
    message: string;
    nextAction?: string;
}
export declare function listSlackRecentChats(options: {
    botToken: string;
    timeoutMs?: number;
    limit?: number;
    includeArchived?: boolean;
}): Promise<SlackRecentChatsResult>;
