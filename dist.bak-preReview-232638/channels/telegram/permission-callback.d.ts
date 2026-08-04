import { type DurablePermissionInteractionContext } from '../../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalDecisionMode } from '../../domain/types.js';
interface TelegramPermissionCallbackContext {
    callbackQuery?: {
        from?: {
            id?: number | string;
            first_name?: string;
            username?: string;
        };
        message?: {
            message_id?: number;
            message_thread_id?: number;
            chat?: {
                id?: number | string;
            };
        };
    };
    chat?: {
        id?: number | string;
    };
    from?: {
        id?: number | string;
        first_name?: string;
        username?: string;
    };
    api: {
        deleteMessage(chatId: string, messageId: number): Promise<unknown>;
        editMessageText(chatId: string, messageId: number, text: string, options: Record<string, unknown>): Promise<unknown>;
        sendMessage(chatId: string, text: string, options: Record<string, unknown>): Promise<unknown>;
    };
    answerCallbackQuery: (input: {
        text: string;
        show_alert: boolean;
    }) => Promise<unknown>;
}
export declare function resolveDurableTelegramPermissionCallback(input: {
    context: TelegramPermissionCallbackContext;
    appId: string;
    providerAlias: string;
    mode: PermissionApprovalDecisionMode;
    sanitizeErrorMessage: (err: unknown) => string;
    isAuthorized: (approvalContextJid: string, userId: string, durable: DurablePermissionInteractionContext) => Promise<boolean>;
}): Promise<void>;
export {};
