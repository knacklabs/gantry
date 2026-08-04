import type { Api } from 'grammy';
type TelegramSendMessageOptions = {
    message_thread_id?: number;
    reply_markup?: {
        inline_keyboard: Array<Array<{
            text: string;
            callback_data: string;
        } | {
            text: string;
            url: string;
        }>>;
    };
};
export declare function sendTelegramPlannedChunk(api: {
    sendMessage: Api['sendMessage'];
}, chatId: string | number, text: string, options?: {
    sendOptions?: TelegramSendMessageOptions;
    plainText?: string;
    allowPlainTextFallback?: boolean;
    forcePlainText?: boolean;
}): Promise<{
    messageId?: number;
    usedPlainText: boolean;
}>;
export {};
