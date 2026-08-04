export declare function sendTelegramTyping(input: {
    bot: {
        api: {
            sendChatAction: (chatId: string, action: 'typing') => Promise<unknown>;
        };
    } | null;
    jid: string;
    isTyping: boolean;
}): Promise<void>;
