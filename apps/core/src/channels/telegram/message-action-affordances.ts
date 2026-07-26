import type {
  MemoryReviewActionDecision,
  MessageActionAffordance,
} from '../../domain/types.js';
import type {
  ReviewMessageSide,
  ReviewMessageView,
} from '../../memory/review-message-view.js';
import { escapeTelegramHtml } from './html-render.js';

const TELEGRAM_ACTION_CALLBACK_BY_KIND: Record<
  MessageActionAffordance['kind'],
  string
> = {
  scheduler_run_now: 'retry',
  scheduler_pause_job: 'pause',
  live_turn_stop: '',
  // ponytail: memory_review_decision rendering lands in Task 6 (Telegram codec).
  memory_review_decision: '',
};
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

function telegramSchedulerActionCallback(
  action: Extract<
    MessageActionAffordance,
    { kind: 'scheduler_run_now' | 'scheduler_pause_job' }
  >,
): string | undefined {
  if (action.kind !== 'scheduler_run_now') {
    return `dl:${TELEGRAM_ACTION_CALLBACK_BY_KIND[action.kind]}`;
  }
  const callbackData = `r:${encodeURIComponent(action.jobId)}`;
  return Buffer.byteLength(callbackData, 'utf8') <=
    TELEGRAM_CALLBACK_DATA_MAX_BYTES
    ? callbackData
    : undefined;
}

export function telegramActionReplyMarkup(actions?: MessageActionAffordance[]):
  | {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  | undefined {
  const buttons = (actions ?? [])
    .map((action) => {
      if (action.kind === 'live_turn_stop') return null;
      if (action.kind === 'memory_review_decision') return null;
      const code = TELEGRAM_ACTION_CALLBACK_BY_KIND[action.kind];
      if (!code || !action.label.trim()) return null;
      const callbackData = telegramSchedulerActionCallback(action);
      if (!callbackData) return null;
      return {
        text: action.label.trim(),
        callback_data: callbackData,
      };
    })
    .filter(
      (button): button is { text: string; callback_data: string } =>
        button !== null,
    );
  if (buttons.length === 0) return undefined;
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> =
    [];
  for (let index = 0; index < buttons.length; index += 2) {
    inline_keyboard.push(buttons.slice(index, index + 2));
  }
  return { inline_keyboard };
}

const TELEGRAM_REVIEW_DECISION_CODE: Record<
  MemoryReviewActionDecision,
  string
> = {
  approve: 'a',
  reject: 'r',
  edit: 'e',
};

export const TELEGRAM_REVIEW_CALLBACK_PATTERN = /^mr:([are]):(.+)$/;

export const TELEGRAM_REVIEW_DECISION_BY_CODE: Record<
  string,
  MemoryReviewActionDecision
> = {
  a: 'approve',
  r: 'reject',
  e: 'edit',
};

/**
 * Compact `mr:<a|r|e>:<reviewId>` callback_data. Review ids are `mrv_` + 32 hex
 * (36 chars) so this is 41 bytes — well under Telegram's 64-byte cap. The guard
 * drops a button that would exceed it rather than truncate an id into ambiguity.
 * ponytail: fixed id length keeps us clear; add a short-token table only if ids grow.
 */
function telegramReviewCallbackData(
  decision: MemoryReviewActionDecision,
  reviewId: string,
): string | undefined {
  const data = `mr:${TELEGRAM_REVIEW_DECISION_CODE[decision]}:${reviewId}`;
  return Buffer.byteLength(data, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
    ? data
    : undefined;
}

function telegramSideLine(side: ReviewMessageSide): string {
  const meta = [side.source, side.date].filter(Boolean).join(' · ');
  const value = `<b>${escapeTelegramHtml(side.label)}:</b> "${escapeTelegramHtml(side.value)}"`;
  return meta ? `${value} — ${escapeTelegramHtml(meta)}` : value;
}

/**
 * Compact-structured Telegram message (HTML parse mode) for a memory review:
 * bold title, Topic, each side line, the change + why, and — when present —
 * bounded evidence inside an EXPANDABLE blockquote so it never walls the chat.
 * The inline keyboard carries the three approve/reject/edit buttons.
 */
export function telegramReviewMessage(view: ReviewMessageView): {
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
} {
  const lines = [
    `<b>${escapeTelegramHtml(view.title)}</b>`,
    `<b>Topic:</b> ${escapeTelegramHtml(view.topic)}`,
    ...view.sides.map(telegramSideLine),
    `<b>Change →</b> ${escapeTelegramHtml(view.change)}`,
    `<b>Why:</b> ${escapeTelegramHtml(view.why)}`,
  ];
  if (view.evidence.length > 0) {
    const evidenceLines = view.evidence
      .map(
        (item) =>
          `${escapeTelegramHtml([item.source, item.date].filter(Boolean).join(' · '))}: ${escapeTelegramHtml(item.snippet)}`,
      )
      .join('\n');
    lines.push(`<blockquote expandable>${evidenceLines}</blockquote>`);
  }
  const buttons = view.affordances
    .map((affordance) => {
      const callback_data = telegramReviewCallbackData(
        affordance.decision,
        affordance.reviewId,
      );
      return callback_data ? { text: affordance.label, callback_data } : null;
    })
    .filter(
      (button): button is { text: string; callback_data: string } =>
        button !== null,
    );
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [buttons] },
  };
}
