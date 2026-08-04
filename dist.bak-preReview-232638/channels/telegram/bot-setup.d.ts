import { Bot } from 'grammy';
import { streamApi } from '@grammyjs/stream';
import { type TelegramContext } from './channel-shared.js';
export declare function createTelegramBotRuntime(botToken: string): {
    bot: Bot<TelegramContext>;
    draftStreamApi: ReturnType<typeof streamApi>;
};
export declare function registerTelegramBotCommands(bot: Bot<TelegramContext>, assistantName: string): void;
