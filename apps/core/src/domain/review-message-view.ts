import type { MemoryReviewActionDecision } from './message-actions.js';

/**
 * Provider-neutral view model for a memory-review message. Each channel adapter
 * maps this to its own native blocks; nothing here is provider-specific. Every
 * field is sourced from the review's IMMUTABLE snapshot (Task 3), never live
 * rows, so the message a reviewer sees never drifts from what was flagged.
 *
 * Layout is the locked "compact structured" shape:
 *   <title>
 *   Topic: <topic>
 *   • <side.label>: "<value>" — <source> · <date>   (one per side)
 *   Change → <change>
 *   Why: <why>
 *   [evidence — collapsible, bounded]
 *   [Approve] [Reject] [Edit]
 */
export interface ReviewMessageView {
  reviewId: string;
  kind: 'contradiction' | 'retire' | 'rewrite' | 'merge';
  title: string;
  topic: string;
  sides: ReviewMessageSide[];
  change: string;
  why: string;
  evidence: ReviewMessageEvidence[];
  affordances: ReviewMessageAffordance[];
  /** How many OTHER reviews are still pending beyond this one, so each native
   * renderer can show a "＋N more pending" indicator (this message shows only
   * the first). Unset/0 when this is the only pending review. */
  morePendingCount?: number;
}

export interface ReviewMessageSide {
  label: string;
  value: string;
  source?: string;
  date?: string;
}

export interface ReviewMessageEvidence {
  source: string;
  snippet: string;
  date?: string;
  uri?: string;
}

export interface ReviewMessageAffordance {
  label: string;
  decision: MemoryReviewActionDecision;
  reviewId: string;
}

/**
 * Shared "＋N more pending review(s)" indicator, so every surface (native cards
 * and the text fallback) words it identically. Returns undefined when this is
 * the only pending review. Pure over the view model, so channel adapters can
 * consume it without reaching into the runtime memory layer.
 */
export function morePendingReviewsLabel(
  view: ReviewMessageView,
): string | undefined {
  const more = view.morePendingCount ?? 0;
  if (more <= 0) return undefined;
  return `＋${more} more pending review${more === 1 ? '' : 's'}`;
}
