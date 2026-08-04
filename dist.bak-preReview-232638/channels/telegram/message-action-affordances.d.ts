import type { MessageActionAffordance } from '../../domain/types.js';
export declare function telegramActionReplyMarkup(actions?: MessageActionAffordance[]): {
    inline_keyboard: Array<Array<{
        text: string;
        callback_data: string;
    }>>;
} | undefined;
