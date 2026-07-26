import type { ObserverFeedbackAction } from '../../domain/message-actions.js';
import type { ObserverDigestMessageView } from '../../domain/observer-digest-view.js';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import { escapeTelegramHtml } from './html-render.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';

const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_CALLBACK_ANSWER_MAX_CHARS = 200;

/**
 * Telegram caps answerCallbackQuery text at 200 chars; longer text is rejected
 * (and our .catch swallows it, so the clicker would get NO alert). Truncate by
 * CODE POINTS (Array.from splits on whole code points) so a surrogate-pair emoji
 * — e.g. the digest markers ✓/💤 — straddling the boundary never gets sliced
 * into a lone surrogate. '…' is one code point, so the result stays ≤200.
 */
export function truncateTelegramCallbackAnswer(text: string): string {
  const codePoints = Array.from(text);
  return codePoints.length <= TELEGRAM_CALLBACK_ANSWER_MAX_CHARS
    ? text
    : `${codePoints.slice(0, TELEGRAM_CALLBACK_ANSWER_MAX_CHARS - 1).join('')}…`;
}

const OBSERVER_FEEDBACK_CODE: Record<ObserverFeedbackAction, string> = {
  resolve: 'r',
  dismiss: 'd',
  snooze: 's',
  less_like_this: 'l',
};

export const OBSERVER_FEEDBACK_BY_CODE: Record<string, ObserverFeedbackAction> =
  {
    r: 'resolve',
    d: 'dismiss',
    s: 'snooze',
    l: 'less_like_this',
  };

// `ob:<r|d|s|l>:<insightId>`. Insight ids are `prin_` + uuid (~41 chars), so the
// callback stays ~46 bytes — well under Telegram's 64-byte cap.
export const TELEGRAM_OBSERVER_CALLBACK_PATTERN = /^ob:([rdsl]):(.+)$/;

function observerCallbackData(
  action: ObserverFeedbackAction,
  insightId: string,
): string | undefined {
  const data = `ob:${OBSERVER_FEEDBACK_CODE[action]}:${insightId}`;
  return Buffer.byteLength(data, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
    ? data
    : undefined;
}

/**
 * One Telegram message (HTML parse mode) for the observer digest: a bold header,
 * then per insight a numbered bold title, summary, italic type, and — once acted
 * on — its state marker. The inline keyboard carries one row of four
 * `observer_feedback` buttons per still-open insight; a settled insight has no
 * row, so acting on one leaves the others fully actionable. Same renderer serves
 * the initial send and the per-outcome rebuild.
 */
export function telegramObserverDigestMessage(
  view: ObserverDigestMessageView,
): {
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
} {
  const lines = [
    `<b>Observer digest — ${escapeTelegramHtml(view.localDay)}</b>`,
  ];
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> =
    [];
  view.insights.forEach((insight, index) => {
    lines.push('');
    lines.push(`<b>${index + 1}. ${escapeTelegramHtml(insight.title)}</b>`);
    if (insight.summary) lines.push(escapeTelegramHtml(insight.summary));
    lines.push(`<i>${escapeTelegramHtml(insight.type)}</i>`);
    if (insight.stateMarker) {
      lines.push(escapeTelegramHtml(insight.stateMarker));
      return;
    }
    const row = insight.affordances
      .map((affordance) => {
        const callback_data = observerCallbackData(
          affordance.action,
          affordance.insightId,
        );
        return callback_data ? { text: affordance.label, callback_data } : null;
      })
      .filter(
        (button): button is { text: string; callback_data: string } =>
          button !== null,
      );
    if (row.length > 0) inline_keyboard.push(row);
  });
  return { text: lines.join('\n'), reply_markup: { inline_keyboard } };
}

/**
 * Observer digest sent as native Telegram HTML with an inline keyboard (parse
 * mode HTML, bypassing the MarkdownV2 pipeline the default send uses — mirrors
 * the memory-review send). `bot` is the grammy Bot (typed `any` to keep this
 * module off the grammy import, like the other telegram send helpers).
 */
export async function sendTelegramObserverDigestMessage(input: {
  bot: any;
  jid: string;
  options: MessageSendOptions;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<MessageDeliveryResult> {
  const { bot, jid, options, sanitizeErrorMessage } = input;
  const view = options.observerDigestView;
  if (!view || !bot) return {};
  const numericId = jid.replace(/^tg:/, '');
  const rendered = telegramObserverDigestMessage(view);
  const threadOpts = telegramThreadOptionsFromString(options.threadId);
  try {
    const sent = await bot.api.sendMessage(numericId, rendered.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: rendered.reply_markup,
      ...threadOpts,
    });
    const messageId = sent?.message_id;
    return {
      ...(messageId !== undefined
        ? {
            externalMessageId: String(messageId),
            externalMessageIds: [String(messageId)],
          }
        : {}),
      deliveredParts: 1,
      totalParts: 1,
    };
  } catch (err) {
    logger.error(
      { jid, error: sanitizeErrorMessage(err) },
      'Failed to send Telegram observer digest message',
    );
    throw err;
  }
}
