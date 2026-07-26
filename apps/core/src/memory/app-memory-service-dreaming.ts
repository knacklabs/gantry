import type {
  MemoryBoundaryContext,
  MemorySubjectType,
} from './memory-types.js';

export function summarizeDreamDecisions(
  decisions: Array<{ action: string; reviewId?: string }>,
  dryRun: boolean,
  options: { pendingReviews?: number } = {},
) {
  const count = (action: string) =>
    decisions.filter((decision) => decision.action === action).length;
  const needsReview = count('needs_review');
  const pendingReviews =
    typeof options.pendingReviews === 'number' &&
    Number.isFinite(options.pendingReviews)
      ? Math.max(0, Math.trunc(options.pendingReviews))
      : needsReview;
  // Ids of reviews this run newly surfaced, carried structurally so the terminal
  // notification can render the actual review instead of a bare count — never by
  // reverse-parsing the human summary.
  const createdReviewIds = decisions
    .map((decision) => decision.reviewId)
    .filter((id): id is string => Boolean(id));
  return {
    decisions: decisions.length,
    promoted: count('promote'),
    updated: count('update'),
    retired: count('retire'),
    skipped: count('skip'),
    blocked: count('blocked'),
    dryRunDecisions: count('dry_run'),
    needsReview,
    pendingReviews,
    createdReviewIds,
    dryRun,
  };
}

export function hasDreamingStatusSubjectScope(
  input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
  },
): boolean {
  return Boolean(
    input.subjectType ||
    input.subjectId ||
    input.userId ||
    input.groupId ||
    input.channelId,
  );
}
