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
// Headroom under Telegram's hard 4096-char message limit. EVERY reserved insight
// is kept (dropping one would silently settle it to a 7-day cooldown the owner
// never saw); an overflowing digest is shrunk by trimming summaries instead.
const TELEGRAM_MESSAGE_SAFE_CEILING = 4000;

// Truncate `value` to at most `maxUnits` UTF-16 code units (Telegram's metric,
// == JS `.length`) while cutting on WHOLE code points, so an emoji straddling the
// boundary is never sliced into a lone surrogate. A supplementary char costs 2
// units, so emoji-heavy content can't slip past the budget. The '…' marker costs
// 1 unit and is included in the budget.
function truncateUtf16Units(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  const budget = Math.max(0, maxUnits - 1); // reserve 1 unit for the ellipsis
  let out = '';
  for (const codePoint of value) {
    if (out.length + codePoint.length > budget) break;
    out += codePoint;
  }
  return `${out}…`;
}

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

// `ob:<r|d|s|l>:<insightId>:<localDay>`. Insight ids are `prin_` + uuid (~41
// chars) and localDay is a 10-char YYYY-MM-DD, so the callback stays ~57 bytes —
// under Telegram's 64-byte cap. The localDay pins the click to its exact digest.
export const TELEGRAM_OBSERVER_CALLBACK_PATTERN = /^ob:([rdsl]):([^:]+):(.+)$/;

/**
 * Decode a Telegram `ob:` callback token + resolve its routing. Returns null
 * when the data is not an observer-feedback token; otherwise the decoded action
 * + insight + localDay and the resolved chat/thread (chatId may be '' when
 * Telegram gave us no chat, which the caller treats as undeliverable).
 */
export function parseTelegramObserverCallback(input: {
  data: string;
  callbackMessage?: {
    chat?: { id?: number | string };
    message_thread_id?: number;
  };
  fallbackChatId?: string | number;
}): {
  action: ObserverFeedbackAction;
  insightId: string;
  localDay: string;
  chatId: string;
  threadId?: string;
} | null {
  const match = TELEGRAM_OBSERVER_CALLBACK_PATTERN.exec(input.data);
  if (!match) return null;
  const chatId =
    input.callbackMessage?.chat?.id?.toString() ||
    input.fallbackChatId?.toString() ||
    '';
  const threadId = input.callbackMessage?.message_thread_id;
  return {
    action: OBSERVER_FEEDBACK_BY_CODE[match[1]!]!,
    insightId: match[2]!,
    localDay: match[3]!,
    chatId,
    ...(typeof threadId === 'number' ? { threadId: String(threadId) } : {}),
  };
}

function observerCallbackData(
  action: ObserverFeedbackAction,
  insightId: string,
  localDay: string,
): string | undefined {
  const data = `ob:${OBSERVER_FEEDBACK_CODE[action]}:${insightId}:${localDay}`;
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
  const header = `Observer digest — ${view.localDay}`;
  // Per-insight mutable title/summary (start FULL, already domain-capped).
  const fields = view.insights.map((insight) => ({
    title: insight.title,
    summary: insight.summary,
  }));

  // The RENDERED text Telegram measures: HTML tags aren't counted and entities
  // render to one char, so the plain (pre-escape/pre-tag) assembly IS the
  // rendered text, and its `.length` is the UTF-16-unit count against the limit.
  const renderedLength = (): number => {
    const parts = [header];
    view.insights.forEach((insight, i) => {
      parts.push('', `${i + 1}. ${fields[i]!.title}`);
      if (fields[i]!.summary) parts.push(fields[i]!.summary);
      parts.push(insight.type);
      if (insight.stateMarker) parts.push(insight.stateMarker);
    });
    return parts.join('\n').length;
  };

  // Measure-first: only shrink when the FULL digest overflows — a long summary
  // is left untouched if short siblings leave enough room. On overflow, trim
  // summaries LONGEST-FIRST (units, surrogate-safe) until it fits; drop a
  // summary fully before touching any title, and only trim a title when every
  // summary is already empty. Every insight + keyboard row is always kept.
  // ponytail: sized for the small top-N maxInsights; an absurdly large
  // maxInsights would need multi-message splitting (not built).
  while (renderedLength() > TELEGRAM_MESSAGE_SAFE_CEILING) {
    const overflow = renderedLength() - TELEGRAM_MESSAGE_SAFE_CEILING;
    let idx = -1;
    fields.forEach((field, i) => {
      if (
        field.summary.length > 0 &&
        (idx < 0 || field.summary.length > fields[idx]!.summary.length)
      ) {
        idx = i;
      }
    });
    if (idx >= 0) {
      const summary = fields[idx]!.summary;
      fields[idx]!.summary =
        overflow >= summary.length
          ? ''
          : truncateUtf16Units(summary, summary.length - overflow);
      continue;
    }
    // Every summary empty: trim the longest title (never drops the insight).
    let tIdx = -1;
    fields.forEach((field, i) => {
      if (
        field.title.length > 0 &&
        (tIdx < 0 || field.title.length > fields[tIdx]!.title.length)
      ) {
        tIdx = i;
      }
    });
    if (tIdx < 0) break;
    const title = fields[tIdx]!.title;
    const trimmed = truncateUtf16Units(
      title,
      Math.max(1, title.length - overflow),
    );
    if (trimmed.length >= title.length) break; // no progress — stop
    fields[tIdx]!.title = trimmed;
  }

  const lines = [`<b>${escapeTelegramHtml(header)}</b>`];
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> =
    [];
  view.insights.forEach((insight, index) => {
    lines.push(
      '',
      `<b>${index + 1}. ${escapeTelegramHtml(fields[index]!.title)}</b>`,
    );
    if (fields[index]!.summary) {
      lines.push(escapeTelegramHtml(fields[index]!.summary));
    }
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
          affordance.localDay,
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
