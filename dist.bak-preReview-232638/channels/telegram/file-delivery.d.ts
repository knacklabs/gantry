import type { MessageFileAttachment, MessageSendOptions } from '../../domain/types.js';
type TelegramFileApi = {
    sendDocument: (...args: any[]) => Promise<{
        message_id?: number;
    }>;
    sendMessage: (...args: any[]) => Promise<{
        message_id?: number;
    }>;
};
export declare function sendTelegramDocuments(input: {
    api: TelegramFileApi;
    chatId: string;
    threadId?: string;
    files?: MessageFileAttachment[];
}): Promise<string[]>;
export declare function appendTelegramDocumentMessageIds(externalMessageIds: string[], api: TelegramFileApi, chatId: string, options: Pick<MessageSendOptions, 'threadId' | 'files'>): Promise<void>;
export {};
