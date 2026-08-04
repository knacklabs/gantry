export declare function addTelegramReaction(input: {
    bot: {
        api: {
            setMessageReaction(chatId: string, messageId: number, reactions: Array<{
                type: 'emoji';
                emoji: never;
            }>, options: {
                is_big: boolean;
            }): Promise<unknown>;
        };
    };
    jid: string;
    messageRef: string;
    emoji: string;
    reactionKeys: Set<string>;
}): Promise<void>;
