import type { ProgressUpdateOptions } from '../../domain/types.js';
import { editTelegramMessage, sendTelegramMessageWithResult, type ActiveProgressState, type TelegramSendMessageOptions } from './channel-shared.js';
export declare function progressActionOptions(options: ProgressUpdateOptions): {
    sendOptions: TelegramSendMessageOptions;
    editReplyMarkup: Record<string, unknown>;
};
export declare function prepareTelegramProgressHandle(input: {
    activeProgressMessages: Map<string, ActiveProgressState>;
    persistProgressMessages: () => void;
    jid: string;
    key: string;
    existing?: ActiveProgressState;
    chatId: string;
    threadId?: number;
    options: ProgressUpdateOptions;
}): {
    accepted: boolean;
    existing?: ActiveProgressState;
};
export declare function clearProgressActions(input: {
    api: Parameters<typeof editTelegramMessage>[0];
    chatId: string;
    messageId?: number;
    text: string;
    editReplyMarkup: Record<string, unknown>;
}): Promise<void>;
export declare function sendNewProgressMessage(input: {
    api: Parameters<typeof sendTelegramMessageWithResult>[0];
    activeProgressMessages: Map<string, ActiveProgressState>;
    persistProgressMessages: () => void;
    chatId: string | number;
    key: string;
    jid: string;
    text: string;
    options: ProgressUpdateOptions;
    sendOptions: TelegramSendMessageOptions;
    threadId?: number;
}): Promise<void>;
