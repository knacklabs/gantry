import { logger } from '../../infrastructure/logging/logger.js';
export async function sendTelegramTyping(input) {
    if (!input.bot || !input.isTyping)
        return;
    try {
        await input.bot.api.sendChatAction(input.jid.replace(/^tg:/, ''), 'typing');
    }
    catch (err) {
        logger.debug({ jid: input.jid, err }, 'Failed to send Telegram typing indicator');
    }
}
