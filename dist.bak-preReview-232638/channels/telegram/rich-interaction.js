import { logger } from '../../infrastructure/logging/logger.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';
import { richDescriptor, RICH_INTERACTION_FALLBACK_COPY, richFallbackText, richHtmlEscape, richTextLines, } from '../rich-interaction.js';
export function renderTelegramRichInteractionHtml(input) {
    const item = richDescriptor(input);
    const text = richTextLines(input)
        .map((line, index) => index === 0 ? `<b>${richHtmlEscape(line)}</b>` : richHtmlEscape(line))
        .join('\n');
    const actions = item.actions?.slice(0, 8).map((action) => ({
        text: action.label,
        callback_data: `rich:${item.id}:${action.id}`.slice(0, 64),
    }));
    return {
        text,
        ...(actions?.length
            ? { reply_markup: { inline_keyboard: actions.map((action) => [action]) } }
            : {}),
    };
}
export async function renderTelegramRichInteraction(input) {
    const { bot, jid, render, sendFallback } = input;
    const numericId = jid.replace(/^tg:/, '');
    const payload = renderTelegramRichInteractionHtml(render);
    try {
        await bot.api.sendMessage(numericId, payload.text, {
            ...telegramThreadOptionsFromString(render.threadId),
            parse_mode: 'HTML',
            ...(payload.reply_markup
                ? { reply_markup: payload.reply_markup }
                : {}),
        });
        return true;
    }
    catch (err) {
        logger.warn({ jid, err }, 'Telegram rich interaction render failed');
        await sendFallback(`${RICH_INTERACTION_FALLBACK_COPY}\n\n${richFallbackText(render)}`, { threadId: render.threadId });
        return true;
    }
}
