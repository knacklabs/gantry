import type { Filter } from 'grammy';
import type { ChannelOpts } from '../channel-provider.js';
import type { TelegramContext } from './channel-shared.js';
export declare function handleTelegramTextMessage(input: {
    ctx: Filter<TelegramContext, 'message:text'>;
    opts: ChannelOpts;
    assistantName: string;
    triggerPattern: RegExp;
    tryResolveOther: (input: {
        chatId: string;
        replyToMessageId: number;
        text: string;
        userId: string;
        answeredBy: string;
    }) => Promise<boolean>;
}): Promise<void>;
