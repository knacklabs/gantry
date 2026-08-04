import { logger } from '../../infrastructure/logging/logger.js';
function telegramReactionEmoji(emoji) {
    if (emoji === 'seen')
        return '👀';
    if (emoji === 'running')
        return '⏳';
    return emoji;
}
export async function addTelegramReaction(input) {
    const numericId = input.jid.replace(/^tg:/, '');
    const messageId = Number.parseInt(input.messageRef, 10);
    if (!Number.isFinite(messageId))
        return;
    const reaction = telegramReactionEmoji(input.emoji);
    const key = `${input.jid}:${messageId}:${reaction}`;
    if (input.reactionKeys.has(key))
        return;
    try {
        await input.bot.api.setMessageReaction(numericId, messageId, [{ type: 'emoji', emoji: reaction }], { is_big: false });
        input.reactionKeys.add(key);
    }
    catch (err) {
        logger.debug({ jid: input.jid, messageRef: input.messageRef, err }, 'Telegram reaction update failed');
    }
}
