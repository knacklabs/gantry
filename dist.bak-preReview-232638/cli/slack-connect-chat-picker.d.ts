export type SlackChatChoice = {
    type: 'selected';
    chatJid: string;
} | {
    type: 'skip';
} | {
    type: 'cancel';
};
export declare function chooseSlackChatForConnect(botToken: string, defaultChatJid?: string): Promise<SlackChatChoice>;
