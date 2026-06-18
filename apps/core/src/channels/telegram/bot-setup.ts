import https from 'https';

import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { stream, streamApi } from '@grammyjs/stream';

import {
  escapeTelegramMarkdownV2Literal,
  type TelegramContext,
} from './channel-shared.js';

export function createTelegramBotRuntime(botToken: string): {
  bot: Bot<TelegramContext>;
  draftStreamApi: ReturnType<typeof streamApi>;
} {
  const bot = new Bot<TelegramContext>(botToken, {
    client: {
      baseFetchConfig: { agent: https.globalAgent, compress: true },
    },
  });
  bot.api.config.use(autoRetry());
  bot.use(stream());
  return { bot, draftStreamApi: streamApi(bot.api.raw) };
}

export function registerTelegramBotCommands(
  bot: Bot<TelegramContext>,
  assistantName: string,
): void {
  bot.command('chatid', (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    const chatName =
      chatType === 'private'
        ? ctx.from?.first_name || 'Private'
        : (ctx.chat as any).title || 'Unknown';

    ctx.reply(
      `Chat ID: \`tg:${escapeTelegramMarkdownV2Literal(String(chatId))}\`\nName: ${escapeTelegramMarkdownV2Literal(chatName)}\nType: ${escapeTelegramMarkdownV2Literal(chatType)}`,
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('ping', (ctx) => {
    ctx.reply(`${assistantName} is online.`);
  });
}
