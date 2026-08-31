import type {
  JobNotificationView,
  MessageActionAffordance,
  MessageSendOptions,
} from '../../domain/types.js';
import {
  morePendingReviewsLabel,
  type ReviewMessageSide,
  type ReviewMessageView,
} from '../../domain/review-message-view.js';
import { formatDuration } from '../../shared/human-format.js';
import { slackBrainReviewBlocks } from './brain-review-affordances.js';
import { slackObserverDigestBlocks } from './observer-digest-affordances.js';

const SLACK_ACTION_VALUE_MAX_BYTES = 2000;
const SLACK_SECTION_TEXT_MAX_LENGTH = 3000;
const SCHEDULER_ACTION_KINDS = new Set<MessageActionAffordance['kind']>([
  'scheduler_run_now',
  'scheduler_pause_job',
  'scheduler_retry_ask',
]);

export function slackActionBlocks(text: string, options: MessageSendOptions) {
  if (options.observerDigestView) {
    return slackObserverDigestBlocks(options.observerDigestView, {
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    });
  }
  if (options.reviewMessageView) {
    return slackReviewMessageBlocks(options.reviewMessageView, {
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    });
  }
  if (options.jobNotificationView) {
    return slackJobNotificationBlocks(
      options.jobNotificationView,
      options.actionAffordances,
      {
        ...(options.providerAccountId
          ? { providerAccountId: options.providerAccountId }
          : {}),
      },
    );
  }
  if (options.brainReviewView) {
    return slackBrainReviewBlocks(options.brainReviewView, {
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    });
  }
  return options.actionAffordances
    ? slackMessageActionBlocks(text, options.actionAffordances, {
        providerAccountId: options.providerAccountId,
      })
    : undefined;
}

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
  // ponytail: observer_feedback rendering lands in a later OBS-RESOLVE task.
  if (action.kind === 'observer_feedback') return undefined;
  // brain_dream_review_decision has its own renderer (brain-review-affordances).
  if (action.kind === 'brain_dream_review_decision') return undefined;
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
  if (action.kind === 'job_permission_decision') {
    const value = JSON.stringify({
      kind: action.kind,
      actionToken: action.actionToken,
      ...(providerAccountId ? { providerAccountId } : {}),
    });
    return Buffer.byteLength(value, 'utf8') <= SLACK_ACTION_VALUE_MAX_BYTES
      ? value
      : undefined;
  }
  const value = SCHEDULER_ACTION_KINDS.has(action.kind)
    ? JSON.stringify({
        kind: action.kind,
        jobId:
          action.kind === 'scheduler_run_now' ||
          action.kind === 'scheduler_pause_job' ||
          action.kind === 'scheduler_retry_ask'
            ? action.jobId
            : '',
        runId:
          action.kind === 'scheduler_run_now' ||
          action.kind === 'scheduler_pause_job' ||
          action.kind === 'scheduler_retry_ask'
            ? (action.runId ?? null)
            : null,
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
    .map((action, index) => {
      const value = slackActionValue(action, options.providerAccountId);
      if (!value) return null;
      return {
        type: 'button',
        // Slack rejects duplicate action_ids within one actions block
        // (invalid_blocks), so every button gets an index-suffixed id.
        action_id: `gantry_message_action:${index}`,
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

function truncateSlackSectionText(value: string): string {
  if (value.length <= SLACK_SECTION_TEXT_MAX_LENGTH) return value;
  let truncated = '';
  for (const codePoint of value) {
    if (
      truncated.length + codePoint.length >
      SLACK_SECTION_TEXT_MAX_LENGTH - 3
    ) {
      break;
    }
    truncated += codePoint;
  }
  return `${truncated}...`;
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
  const elements = view.affordances.map((affordance, index) => ({
    type: 'button',
    action_id: `gantry_message_action:${index}`,
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

const SLACK_JOB_STATUS: Record<
  JobNotificationView['status'],
  { emoji: string; label: string }
> = {
  completed: { emoji: '✅', label: 'Completed' },
  failed: { emoji: '❌', label: 'Failed' },
  paused: { emoji: '⏸️', label: 'Paused' },
  timeout: { emoji: '⏱️', label: 'Timed out' },
  dead_lettered: { emoji: '⏸️', label: 'Paused after failures' },
};

const SLACK_JOB_OUTCOME_MARKER: Record<
  NonNullable<JobNotificationView['result']>['items'][number]['outcome'],
  string
> = {
  done: '✅',
  skipped: '⏭️',
  failed: '❌',
};

export function slackJobNotificationBlocks(
  view: JobNotificationView,
  actions?: MessageActionAffordance[],
  options: { providerAccountId?: string } = {},
): Array<Record<string, unknown>> {
  const status = SLACK_JOB_STATUS[view.status];
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${status.emoji} ${status.label} · ${view.jobName}`,
        emoji: true,
      },
    },
  ];
  if (view.stats) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            ...(view.durationMs === undefined
              ? []
              : [formatDuration(view.durationMs)]),
            `${view.stats.toolCount} tool${view.stats.toolCount === 1 ? '' : 's'}`,
            view.stats.browserUsed ? 'browser used' : 'browser not used',
            `last ${escapeSlackMrkdwn(view.stats.lastAction ?? 'none')}`,
          ].join(' · '),
        },
      ],
    });
  }
  const body = view.result
    ? [
        ...(view.result.headline
          ? [`*${escapeSlackMrkdwn(view.result.headline)}*`]
          : []),
        ...view.result.items.map((item) =>
          [
            SLACK_JOB_OUTCOME_MARKER[item.outcome],
            escapeSlackMrkdwn(item.label),
            item.detail ? `— ${escapeSlackMrkdwn(item.detail)}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        ),
        ...(view.result.nextAction
          ? [`*Next:* ${escapeSlackMrkdwn(view.result.nextAction)}`]
          : []),
      ]
    : [escapeSlackMrkdwn(view.fallbackText)];
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncateSlackSectionText(body.join('\n')),
    },
  });
  if (view.nextRunAt) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Next run: ${escapeSlackMrkdwn(view.nextRunAt)}`,
        },
      ],
    });
  }
  const actionBlocks = slackMessageActionBlocks('', actions, {
    actionOnly: true,
    providerAccountId: options.providerAccountId,
  });
  if (actionBlocks) blocks.push(...actionBlocks);
  return blocks;
}
