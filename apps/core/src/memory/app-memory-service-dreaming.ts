import type {
  MemoryBoundaryContext,
  MemorySubjectType,
} from './memory-types.js';

export function summarizeDreamDecisions(
  decisions: Array<{ action: string }>,
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
