import type { MessageActionAffordance } from '../../domain/types.js';
import {
  morePendingReviewsLabel,
  type ReviewMessageSide,
  type ReviewMessageView,
} from '../../domain/review-message-view.js';

const SLACK_ACTION_VALUE_MAX_BYTES = 2000;
const SCHEDULER_ACTION_KINDS = new Set<MessageActionAffordance['kind']>([
  'scheduler_run_now',
  'scheduler_pause_job',
]);

function truncateSlackButtonLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= 75) return trimmed;
  return `${trimmed.slice(0, 72)}...`;
}

function slackActionValue(
  action: MessageActionAffordance,
  providerAccountId?: string,
): string | undefined {
  if (action.kind === 'live_turn_stop') return undefined;
  if (action.kind === 'memory_review_decision') {
    const value = JSON.stringify({
      kind: action.kind,
      reviewId: action.reviewId,
      decision: action.decision,
      ...(providerAccountId ? { providerAccountId } : {}),
    });
    return Buffer.byteLength(value, 'utf8') <= SLACK_ACTION_VALUE_MAX_BYTES
      ? value
      : undefined;
  }
  const value = SCHEDULER_ACTION_KINDS.has(action.kind)
    ? JSON.stringify({
        kind: action.kind,
        jobId: action.jobId,
        runId: action.runId ?? null,
        ...(providerAccountId ? { providerAccountId } : {}),
      })
    : undefined;
  if (!value) return undefined;
  return Buffer.byteLength(value, 'utf8') <= SLACK_ACTION_VALUE_MAX_BYTES
    ? value
    : undefined;
}

export function slackMessageActionBlocks(
  text: string,
  actions?: MessageActionAffordance[],
  options: { actionOnly?: boolean; providerAccountId?: string } = {},
): Array<Record<string, unknown>> | undefined {
  const elements = (actions ?? [])
    .map((action) => {
      const value = slackActionValue(action, options.providerAccountId);
      if (!value) return null;
      return {
        type: 'button',
        action_id: 'gantry_message_action',
        text: {
          type: 'plain_text',
          text: truncateSlackButtonLabel(action.label),
        },
        ...(action.kind === 'scheduler_pause_job'
          ? { style: 'danger' as const }
          : {}),
        value,
      };
    })
    .filter((action) => action !== null) as Array<Record<string, unknown>>;
  if (elements.length === 0) return undefined;
  const actionBlock = {
    type: 'actions',
    elements,
  };
  return options.actionOnly
    ? [actionBlock]
    : [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        actionBlock,
      ];
}

/**
 * Escape dynamic snapshot content before embedding it in Slack mrkdwn, so a
 * captured `<@U123>` or `<https://x|label>` can't become a live mention/link
 * when the bot republishes it. Mirrors the Telegram HTML escaping.
 */
function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function slackSideLine(side: ReviewMessageSide): string {
  const meta = [side.source, side.date]
    .filter(Boolean)
    .map((part) => escapeSlackMrkdwn(part as string))
    .join(' · ');
  const value = `*${side.label}:* "${escapeSlackMrkdwn(side.value)}"`;
  return meta ? `${value} — ${meta}` : value;
}

/**
 * Compact-structured Block Kit for a memory-review message: a header (title),
 * a section carrying Topic + each side (value with its "source · date"), a
 * section for the change + why, a bounded evidence context block (collapsed to
 * short snippets — never the full text), and an actions block with the three
 * approve/reject/edit buttons whose value carries {kind, reviewId, decision}.
 */
export function slackReviewMessageBlocks(
  view: ReviewMessageView,
  options: { providerAccountId?: string } = {},
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: view.title, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Topic:* ${escapeSlackMrkdwn(view.topic)}`,
          ...view.sides.map(slackSideLine),
        ].join('\n'),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Change →* ${escapeSlackMrkdwn(view.change)}\n*Why:* ${escapeSlackMrkdwn(view.why)}`,
      },
    },
  ];
  if (view.evidence.length > 0) {
    blocks.push({
      type: 'context',
      elements: view.evidence.map((item) => ({
        type: 'mrkdwn',
        text: `📎 ${escapeSlackMrkdwn([item.source, item.date].filter(Boolean).join(' · '))}: ${escapeSlackMrkdwn(item.snippet)}`,
      })),
    });
  }
  const morePending = morePendingReviewsLabel(view);
  if (morePending) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: escapeSlackMrkdwn(morePending) }],
    });
  }
  const elements = view.affordances.map((affordance) => ({
    type: 'button',
    action_id: 'gantry_message_action',
    text: {
      type: 'plain_text',
      text: truncateSlackButtonLabel(affordance.label),
    },
    ...(affordance.decision === 'reject' ? { style: 'danger' as const } : {}),
    ...(affordance.decision === 'approve' ? { style: 'primary' as const } : {}),
    value: JSON.stringify({
      kind: 'memory_review_decision',
      reviewId: affordance.reviewId,
      decision: affordance.decision,
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    }),
  }));
  blocks.push({ type: 'actions', elements });
  return blocks;
}
