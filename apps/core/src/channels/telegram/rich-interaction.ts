import type { RichInteractionRequest } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';
import {
  isRichForm,
  richDescriptor,
  RICH_INTERACTION_FALLBACK_COPY,
  richFallbackText,
  richHtmlEscape,
  richTextLines,
} from '../rich-interaction.js';
import type { TelegramRichFormSessions } from './rich-form-session.js';

export function renderTelegramRichInteractionHtml(
  input: RichInteractionRequest,
): { text: string; reply_markup?: Record<string, unknown> } {
  const item = richDescriptor(input);
  const text = richTextLines(input)
    .map((line, index) =>
      index === 0 ? `<b>${richHtmlEscape(line)}</b>` : richHtmlEscape(line),
    )
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

export async function renderTelegramRichInteraction(input: {
  bot: any;
  jid: string;
  render: RichInteractionRequest;
  formSessions: TelegramRichFormSessions;
  sendFallback: (
    text: string,
    options: { threadId?: string },
  ) => Promise<unknown>;
}): Promise<boolean> {
  const { bot, jid, render, sendFallback, formSessions } = input;
  const numericId = jid.replace(/^tg:/, '');
  if (isRichForm(render) && Number(numericId) > 0) {
    try {
      const started = await formSessions.start({
        request: render,
        chatId: numericId,
        sendPrompt: async (text, placeholder) => {
          const sent = await bot.api.sendMessage(numericId, text, {
            ...telegramThreadOptionsFromString(render.threadId),
            reply_markup: {
              force_reply: true,
              input_field_placeholder: placeholder,
            },
          });
          return sent.message_id;
        },
      });
      if (started) return true;
    } catch (err) {
      logger.warn({ jid, err }, 'Telegram guided form prompt failed');
    }
  }
  const payload = renderTelegramRichInteractionHtml(render);
  try {
    await bot.api.sendMessage(numericId, payload.text, {
      ...telegramThreadOptionsFromString(render.threadId),
      parse_mode: 'HTML',
      ...(payload.reply_markup
        ? { reply_markup: payload.reply_markup as never }
        : {}),
    });
    return true;
  } catch (err) {
    logger.warn({ jid, err }, 'Telegram rich interaction render failed');
    await sendFallback(
      `${RICH_INTERACTION_FALLBACK_COPY}\n\n${richFallbackText(render)}`,
      { threadId: render.threadId },
    );
    return true;
  }
}
