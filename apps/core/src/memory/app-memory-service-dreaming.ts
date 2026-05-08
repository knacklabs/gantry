import type {
  MemoryBoundaryContext,
  MemorySubjectType,
} from './memory-types.js';

export function summarizeDreamDecisions(
  decisions: Array<{ action: string }>,
  dryRun: boolean,
) {
  const count = (action: string) =>
    decisions.filter((decision) => decision.action === action).length;
  return {
    decisions: decisions.length,
    promoted: count('promote'),
    updated: count('update'),
    retired: count('retire'),
    skipped: count('skip'),
    blocked: count('blocked'),
    dryRunDecisions: count('dry_run'),
    needsReview: count('needs_review'),
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
    input.channelId ||
    input.threadId,
  );
}
