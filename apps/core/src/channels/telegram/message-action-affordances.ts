import type {
  BrainDreamReviewActionDecision,
  JobNotificationView,
  MemoryReviewActionDecision,
  MessageActionAffordance,
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import type { BrainReviewCardView } from '../../domain/brain-review-card.js';
import { formatDuration } from '../../shared/human-format.js';
import {
  morePendingReviewsLabel,
  type ReviewMessageSide,
  type ReviewMessageView,
} from '../../domain/review-message-view.js';
import { escapeTelegramHtml } from './html-render.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  telegramThreadOptionsFromString,
  TELEGRAM_MESSAGE_MAX_LENGTH,
} from './channel-shared.js';

const TELEGRAM_ACTION_CALLBACK_BY_KIND: Record<
  MessageActionAffordance['kind'],
  string
> = {
  scheduler_run_now: 'retry',
  scheduler_pause_job: 'pause',
  live_turn_stop: '',
  job_permission_decision: '',
  // ponytail: memory_review_decision rendering lands in Task 6 (Telegram codec).
  memory_review_decision: '',
  // ponytail: observer_feedback rendering lands in a later OBS-RESOLVE task.
  observer_feedback: '',
  // brain_dream_review_decision has its own renderer (telegramBrainReviewMessage).
  brain_dream_review_decision: '',
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
      if (action.kind === 'observer_feedback') return null;
      if (action.kind === 'brain_dream_review_decision') return null;
      if (action.kind === 'job_permission_decision') {
        return action.label.trim() &&
          Buffer.byteLength(action.actionToken, 'utf8') <=
            TELEGRAM_CALLBACK_DATA_MAX_BYTES
          ? {
              text: action.label.trim(),
              callback_data: action.actionToken,
            }
          : null;
      }
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

const TELEGRAM_BRAIN_REVIEW_DECISION_CODE: Record<
  BrainDreamReviewActionDecision,
  string
> = {
  approve: 'a',
  reject: 'r',
};

export const TELEGRAM_BRAIN_REVIEW_CALLBACK_PATTERN = /^bd:([ar]):(.+)$/;

export const TELEGRAM_BRAIN_REVIEW_DECISION_BY_CODE: Record<
  string,
  BrainDreamReviewActionDecision
> = {
  a: 'approve',
  r: 'reject',
};

// Compact `bd:<a|r>:<reviewId>` callback_data — distinct `bd:` prefix keeps it
// unambiguous from the memory-review `mr:` codec. The guard drops a button that
// would exceed Telegram's 64-byte cap rather than truncate an id.
function brainReviewCallbackData(
  decision: BrainDreamReviewActionDecision,
  reviewId: string,
): string | undefined {
  const data = `bd:${TELEGRAM_BRAIN_REVIEW_DECISION_CODE[decision]}:${reviewId}`;
  return Buffer.byteLength(data, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
    ? data
    : undefined;
}

// Telegram counts message length in UTF-16 units; a payload over the hard limit
// is rejected forever (outbound recovery would retry it endlessly). Truncate an
// already-ESCAPED fragment (escapeTelegramHtml emits only &amp;/&lt;/&gt; — no
// tags) on WHOLE code points, then drop any dangling partial entity so a cut
// never splits `&amp;` into invalid HTML.
function truncateEscapedTelegramHtml(
  escaped: string,
  maxUnits: number,
): string {
  if (escaped.length <= maxUnits) return escaped;
  let out = '';
  for (const codePoint of escaped) {
    if (out.length + codePoint.length > maxUnits) break;
    out += codePoint;
  }
  const lastAmp = out.lastIndexOf('&');
  if (lastAmp !== -1 && !out.slice(lastAmp).includes(';')) {
    out = out.slice(0, lastAmp);
  }
  return out;
}

/**
 * Compact Telegram HTML card for a brain destructive-proposal review: the
 * scannable "what will change" headline (bold) + optional before→after detail
 * lines (all snapshot-derived text HTML-escaped), plus an Approve/Reject inline
 * keyboard. A button whose callback_data overflows the 64-byte cap is dropped.
 *
 * The rendered text is bounded to Telegram's 4096-UTF-16-unit hard limit — a
 * long title/entity name can't produce a permanently-unsendable payload. Only
 * the headline carries tags (<b></b>); truncation is entity-safe, so the HTML
 * stays valid.
 */
export function telegramBrainReviewMessage(view: BrainReviewCardView): {
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
} {
  const BOLD_TAGS = '<b></b>'.length;
  let headline = escapeTelegramHtml(view.headline);
  if (BOLD_TAGS + headline.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
    headline =
      truncateEscapedTelegramHtml(
        headline,
        TELEGRAM_MESSAGE_MAX_LENGTH - BOLD_TAGS - 1,
      ) + '…';
  }
  const lines = [`<b>${headline}</b>`];
  let used = lines[0]!.length;
  for (const raw of view.details) {
    const escaped = escapeTelegramHtml(raw);
    if (used + 1 + escaped.length <= TELEGRAM_MESSAGE_MAX_LENGTH) {
      lines.push(escaped);
      used += 1 + escaped.length;
      continue;
    }
    // Last line that fits gets a truncated fragment (+ ellipsis); then stop.
    const room = TELEGRAM_MESSAGE_MAX_LENGTH - used - 1; // minus the '\n'
    if (room > 1) {
      lines.push(truncateEscapedTelegramHtml(escaped, room - 1) + '…');
    }
    break;
  }
  const buttons = view.buttons
    .map((button) => {
      const callback_data = brainReviewCallbackData(
        button.decision,
        view.reviewId,
      );
      return callback_data ? { text: button.label, callback_data } : null;
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
  const morePending = morePendingReviewsLabel(view);
  if (morePending) lines.push(escapeTelegramHtml(morePending));
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

const TELEGRAM_JOB_STATUS: Record<
  JobNotificationView['status'],
  { emoji: string; label: string }
> = {
  completed: { emoji: '✅', label: 'Completed' },
  failed: { emoji: '❌', label: 'Failed' },
  paused: { emoji: '⏸️', label: 'Paused' },
  timeout: { emoji: '⏱️', label: 'Timed out' },
  dead_lettered: { emoji: '⏸️', label: 'Paused after failures' },
};

const TELEGRAM_JOB_OUTCOME_MARKER: Record<
  NonNullable<JobNotificationView['result']>['items'][number]['outcome'],
  string
> = {
  done: '✅',
  skipped: '⏭️',
  failed: '❌',
};

export function telegramJobNotificationMessage(view: JobNotificationView): {
  text: string;
} {
  const status = TELEGRAM_JOB_STATUS[view.status];
  const duration =
    view.durationMs === undefined
      ? ''
      : ` · ${formatDuration(view.durationMs)}`;
  const lines = [
    `<b>${status.emoji} ${status.label}</b> · ${escapeTelegramHtml(view.jobName)}${duration}`,
  ];
  if (view.stats) {
    lines.push(
      `${view.stats.toolCount} tool${view.stats.toolCount === 1 ? '' : 's'}, ${view.stats.browserUsed ? 'browser used' : 'browser not used'}, last ${escapeTelegramHtml(view.stats.lastAction ?? 'none')}`,
    );
  }
  const body = view.result
    ? [
        ...(view.result.headline
          ? [escapeTelegramHtml(view.result.headline)]
          : []),
        ...view.result.items.map((item) =>
          [
            TELEGRAM_JOB_OUTCOME_MARKER[item.outcome],
            escapeTelegramHtml(item.label),
            item.detail ? `— ${escapeTelegramHtml(item.detail)}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        ),
        ...(view.result.nextAction
          ? [`Next: ${escapeTelegramHtml(view.result.nextAction)}`]
          : []),
      ]
    : [escapeTelegramHtml(view.fallbackText)];
  if (body.length > 0) {
    lines.push(`<blockquote expandable>${body.join('\n')}</blockquote>`);
  }
  if (view.nextRunAt) {
    lines.push(`<i>Next run: ${escapeTelegramHtml(view.nextRunAt)}</i>`);
  }
  return { text: lines.join('\n') };
}

/**
 * Memory-review card: sent as native Telegram HTML with an inline keyboard of
 * Approve/Reject/Edit buttons (parse_mode HTML, not the MarkdownV2 pipeline the
 * default send uses — the review renderer emits HTML with an expandable evidence
 * blockquote). `bot` is the grammy Bot (typed `any` here to keep this module off
 * the grammy import, matching the other telegram send helpers).
 */
export async function sendTelegramReviewMessage(input: {
  bot: any;
  jid: string;
  options: MessageSendOptions;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<MessageDeliveryResult> {
  const { bot, jid, options, sanitizeErrorMessage } = input;
  const view = options.reviewMessageView;
  if (!view || !bot) return {};
  const numericId = jid.replace(/^tg:/, '');
  const rendered = telegramReviewMessage(view);
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
      'Failed to send Telegram memory-review message',
    );
    throw err;
  }
}

export async function sendTelegramJobNotificationMessage(input: {
  bot: any;
  jid: string;
  options: MessageSendOptions;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<MessageDeliveryResult> {
  const { bot, jid, options, sanitizeErrorMessage } = input;
  const view = options.jobNotificationView;
  if (!view || !bot) return {};
  const numericId = jid.replace(/^tg:/, '');
  const rendered = telegramJobNotificationMessage(view);
  const threadOpts = telegramThreadOptionsFromString(options.threadId);
  const replyMarkup = telegramActionReplyMarkup(options.actionAffordances);
  try {
    const sent = await bot.api.sendMessage(numericId, rendered.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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
      'Failed to send Telegram job notification message',
    );
    throw err;
  }
}

/**
 * Brain destructive-proposal review card: sent as native Telegram HTML with an
 * Approve/Reject inline keyboard. Mirrors sendTelegramReviewMessage.
 */
export async function sendTelegramBrainReviewMessage(input: {
  bot: any;
  jid: string;
  options: MessageSendOptions;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<MessageDeliveryResult> {
  const { bot, jid, options, sanitizeErrorMessage } = input;
  const view = options.brainReviewView;
  if (!view || !bot) return {};
  const numericId = jid.replace(/^tg:/, '');
  const rendered = telegramBrainReviewMessage(view);
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
      'Failed to send Telegram brain-review message',
    );
    throw err;
  }
}
