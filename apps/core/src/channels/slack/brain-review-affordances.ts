import type { BrainReviewCardView } from '../../domain/brain-review-card.js';
import type { BrainDreamReviewActionDecision } from '../../domain/types.js';

// Slack render + inbound codec for a brain destructive-proposal review card
// (Approve/Reject). Mirrors the observer-digest / memory-review affordance
// patterns: one static action_id, the discriminator + ids live in `value`, and
// all snapshot-derived text is mrkdwn-escaped + size-bounded.

const SLACK_ACTION_VALUE_MAX_BYTES = 2000;
const SLACK_SECTION_CAP = 2900;

export function slackBrainReviewBlocks(
  view: BrainReviewCardView,
  opts: { providerAccountId?: string } = {},
): unknown[] {
  const lines = [view.headline, ...view.details]
    .map((line) => escapeSlackMrkdwn(line))
    .join('\n');
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateSlackMrkdwn(lines, SLACK_SECTION_CAP),
      },
    },
  ];
  const elements = view.buttons
    .map((button) => {
      const value = JSON.stringify({
        kind: 'brain_dream_review_decision',
        reviewId: view.reviewId,
        decision: button.decision,
        ...(opts.providerAccountId
          ? { providerAccountId: opts.providerAccountId }
          : {}),
      });
      if (Buffer.byteLength(value, 'utf8') > SLACK_ACTION_VALUE_MAX_BYTES) {
        return null;
      }
      return {
        type: 'button',
        action_id: 'gantry_message_action',
        text: {
          type: 'plain_text',
          text: truncateSlackButtonLabel(button.label),
        },
        ...(button.decision === 'approve' ? { style: 'primary' as const } : {}),
        ...(button.decision === 'reject' ? { style: 'danger' as const } : {}),
        value,
      };
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
  if (elements.length > 0) blocks.push({ type: 'actions', elements });
  return blocks;
}

// Fallback/text line for accessibility (screen readers read top-level text).
export function slackBrainReviewFallbackText(
  view: BrainReviewCardView,
): string {
  return [view.headline, ...view.details].join('\n');
}

export function parseSlackBrainReview(value: unknown): {
  reviewId: string;
  decision: BrainDreamReviewActionDecision;
  providerAccountId?: string;
} | null {
  const payload = value as
    | {
        kind?: unknown;
        reviewId?: unknown;
        decision?: unknown;
        providerAccountId?: unknown;
      }
    | undefined;
  if (
    payload?.kind !== 'brain_dream_review_decision' ||
    typeof payload.reviewId !== 'string' ||
    payload.reviewId.trim().length === 0 ||
    (payload.decision !== 'approve' && payload.decision !== 'reject')
  ) {
    return null;
  }
  return {
    reviewId: payload.reviewId,
    decision: payload.decision,
    ...(typeof payload.providerAccountId === 'string'
      ? { providerAccountId: payload.providerAccountId }
      : {}),
  };
}

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

// Code-point / mrkdwn-entity-safe cap so a cut never splits a half-entity or a
// lone surrogate (same discipline the observer digest uses).
function truncateSlackMrkdwn(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  const units =
    escaped.match(/&(?:amp|lt|gt);|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) ??
    [];
  let out = '';
  for (const unit of units) {
    if (out.length + unit.length > max - 1) break;
    out += unit;
  }
  return `${out}…`;
}
