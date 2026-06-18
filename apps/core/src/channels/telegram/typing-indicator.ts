import { logger } from '../../infrastructure/logging/logger.js';

export async function sendTelegramTyping(input: {
  bot: {
    api: {
      sendChatAction: (chatId: string, action: 'typing') => Promise<unknown>;
    };
  } | null;
  jid: string;
  isTyping: boolean;
}): Promise<void> {
  if (!input.bot || !input.isTyping) return;
  try {
    await input.bot.api.sendChatAction(input.jid.replace(/^tg:/, ''), 'typing');
  } catch (err) {
    logger.debug(
      { jid: input.jid, err },
      'Failed to send Telegram typing indicator',
    );
  }
}
