import type { ObserverFeedbackAction } from '../../domain/message-actions.js';
import type {
  ObserverDigestInsightView,
  ObserverDigestMessageView,
} from '../../domain/observer-digest-view.js';

const OBSERVER_FEEDBACK_ACTIONS = new Set<ObserverFeedbackAction>([
  'resolve',
  'dismiss',
  'snooze',
  'less_like_this',
]);

/**
 * Escape dynamic snapshot content before embedding it in Slack mrkdwn, so a
 * captured `<@U123>` or `<https://x|label>` can't become a live mention/link
 * when the bot republishes it. Mirrors the memory-review escaping.
 */
function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function truncateSlackButtonLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length <= 75 ? trimmed : `${trimmed.slice(0, 72)}...`;
}

function slackInsightBlocks(
  insight: ObserverDigestInsightView,
  providerAccountId?: string,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlackMrkdwn(insight.title)}*\n${escapeSlackMrkdwn(insight.summary)}`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_${escapeSlackMrkdwn(insight.type)}_` },
      ],
    },
  ];
  if (insight.stateMarker) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: escapeSlackMrkdwn(insight.stateMarker) },
      ],
    });
    return blocks;
  }
  const elements = insight.affordances.map((affordance) => ({
    type: 'button',
    action_id: 'gantry_message_action',
    text: {
      type: 'plain_text',
      text: truncateSlackButtonLabel(affordance.label),
    },
    value: JSON.stringify({
      kind: 'observer_feedback',
      insightId: affordance.insightId,
      action: affordance.action,
      localDay: affordance.localDay,
      ...(providerAccountId ? { providerAccountId } : {}),
    }),
  }));
  if (elements.length > 0) blocks.push({ type: 'actions', elements });
  return blocks;
}

/**
 * Block Kit for one observer digest message: a header, then per insight a
 * titled section + type context + its own 4-button `observer_feedback` group.
 * Up to 3 insight groups ride in one message; acting on one only clears that
 * group's buttons (see markObserverDigestInsight), so this same renderer serves
 * both the initial send and the per-outcome rebuild.
 */
export function slackObserverDigestBlocks(
  view: ObserverDigestMessageView,
  options: { providerAccountId?: string } = {},
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Observer digest — ${view.localDay}`,
        emoji: true,
      },
    },
  ];
  for (const insight of view.insights) {
    blocks.push(...slackInsightBlocks(insight, options.providerAccountId));
  }
  return blocks;
}

/**
 * Parse a Slack `gantry_message_action` button value into an observer_feedback
 * action. Returns null for any other action kind or a malformed shape.
 */
export function parseSlackObserverFeedback(value: unknown): {
  insightId: string;
  action: ObserverFeedbackAction;
  localDay: string;
  providerAccountId?: string;
} | null {
  const payload = value as
    | {
        kind?: unknown;
        insightId?: unknown;
        action?: unknown;
        localDay?: unknown;
        providerAccountId?: unknown;
      }
    | undefined;
  if (
    payload?.kind !== 'observer_feedback' ||
    typeof payload.insightId !== 'string' ||
    payload.insightId.trim().length === 0 ||
    typeof payload.action !== 'string' ||
    !OBSERVER_FEEDBACK_ACTIONS.has(payload.action as ObserverFeedbackAction) ||
    typeof payload.localDay !== 'string' ||
    payload.localDay.trim().length === 0
  ) {
    return null;
  }
  return {
    insightId: payload.insightId,
    action: payload.action as ObserverFeedbackAction,
    localDay: payload.localDay,
    ...(typeof payload.providerAccountId === 'string'
      ? { providerAccountId: payload.providerAccountId }
      : {}),
  };
}
