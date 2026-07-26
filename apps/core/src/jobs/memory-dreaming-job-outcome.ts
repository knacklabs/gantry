import type { MemoryMaintenanceQueueEnqueueResult } from '../memory/maintenance-queue.js';
import type {
  DreamingRunStatus,
  NormalizedMemorySubject,
} from '../memory/memory-types.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import {
  buildReviewMessageView,
  type ReviewMessageView,
} from '../memory/review-message-view.js';

const MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Typed hand-off from the dreaming run to the terminal notification: which
 * reviews this run newly surfaced plus a fully-built view of the FIRST one, so
 * the notification renders the actual review + action buttons instead of a bare
 * count. Snapshot-sourced (buildReviewMessageView reads the T3 frozen snapshot);
 * never recovered by reverse-parsing the human summary.
 */
export interface MemoryReviewCreatedNotification {
  kind: 'memory_review_created';
  reviewMessageView: ReviewMessageView;
  createdReviewIds: string[];
  pendingCount: number;
}

/** Ids of reviews a completed dreaming run created, read structurally from the
 * run summary (set by summarizeDreamDecisions). Empty for any other shape. */
export function createdReviewIdsFromDreamSummary(summary: unknown): string[] {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return [];
  }
  const value = (summary as Record<string, unknown>).createdReviewIds;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && !!id);
}

/**
 * Load the FIRST newly-created review and build its provider-neutral view. The
 * pending count drives the "＋N more pending" line. Returns null (caller keeps
 * the concise count summary) if there are no new ids or the review can't be
 * loaded — the notification never fabricates content.
 */
export async function buildMemoryReviewCreatedNotification(input: {
  memory: AppMemoryService;
  subject: NormalizedMemorySubject;
  createdReviewIds: string[];
  pendingCount: number;
}): Promise<MemoryReviewCreatedNotification | null> {
  const firstId = input.createdReviewIds[0];
  if (!firstId) return null;
  try {
    const record = await input.memory.getReviewWithinAgentBoundary(
      {
        appId: input.subject.appId,
        agentId: input.subject.agentId,
        reviewId: firstId,
      },
      { statementTimeoutMs: MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS },
    );
    if (!record) return null;
    const reviewMessageView = buildReviewMessageView(record);
    // This message shows the first review; the rest are surfaced as a
    // "＋N more pending" indicator on the native card and the text fallback.
    const morePendingCount = Math.max(0, input.pendingCount - 1);
    if (morePendingCount > 0) {
      reviewMessageView.morePendingCount = morePendingCount;
    }
    return {
      kind: 'memory_review_created',
      reviewMessageView,
      createdReviewIds: input.createdReviewIds,
      pendingCount: input.pendingCount,
    };
  } catch {
    return null;
  }
}

function pendingMemoryReviewLabel(count: number): string {
  return `${count} pending memory review${count === 1 ? '' : 's'}`;
}

function pendingMemoryReviewNotice(count: number): string {
  return `${pendingMemoryReviewLabel(count)} need${count === 1 ? 's' : ''} review`;
}

export async function countPendingReviewsForNotification(input: {
  memory: AppMemoryService;
  subject: NormalizedMemorySubject;
}): Promise<number> {
  try {
    const reviews = await input.memory.listPendingReviews(input.subject, {
      statementTimeoutMs: MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS,
    });
    return reviews.length;
  } catch {
    return 0;
  }
}

export function appendPendingReviewContextToError(
  error: unknown,
  pendingReviews: number,
): Error {
  if (pendingReviews <= 0) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const baseMessage =
    error instanceof Error ? error.message : String(error || 'unknown error');
  const separator = /[.!?]\s*$/.test(baseMessage) ? ' ' : '. ';
  return new Error(
    `${baseMessage}${separator}${pendingMemoryReviewNotice(pendingReviews)}.`,
  );
}

function numericSummaryValue(
  summary: unknown,
  key: string,
): number | undefined {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return undefined;
  }
  const value = (summary as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

export function formatMemoryDreamingOutcome(
  run: DreamingRunStatus | undefined,
  queueResult: MemoryMaintenanceQueueEnqueueResult,
): string {
  if (queueResult.deduped) {
    return 'Memory dreaming was already running for this conversation.';
  }
  if (!run) {
    return 'Memory dreaming completed.';
  }
  if (run.status === 'failed') {
    const summary =
      run.summary && typeof run.summary === 'object'
        ? (run.summary as Record<string, unknown>)
        : {};
    const error = typeof summary.error === 'string' ? summary.error : '';
    const pendingReviews = numericSummaryValue(summary, 'pendingReviews') ?? 0;
    const base = error
      ? `Memory dreaming failed: ${error}${/[.!?]\s*$/.test(error) ? '' : '.'}`
      : 'Memory dreaming failed.';
    return appendPendingReviewNotice(base, pendingReviews);
  }
  const needsReview = numericSummaryValue(run.summary, 'needsReview') ?? 0;
  const pendingReviews =
    numericSummaryValue(run.summary, 'pendingReviews') ?? needsReview;
  const blocked = numericSummaryValue(run.summary, 'blocked') ?? 0;
  const issues: string[] = [];
  if (needsReview > 0) issues.push(`${needsReview} sent to review`);
  if (pendingReviews > needsReview) {
    issues.push(pendingMemoryReviewNotice(pendingReviews));
  }
  if (blocked > 0) issues.push(`${blocked} blocked`);
  if (issues.length > 0) {
    return `Memory dreaming needs attention: ${issues.join(', ')}.`;
  }
  return 'Memory dreaming completed.';
}

function appendPendingReviewNotice(
  summary: string,
  pendingReviews: number,
  alreadyReported = 0,
) {
  if (pendingReviews <= alreadyReported) return summary;
  return `${summary} ${pendingMemoryReviewNotice(pendingReviews)}.`;
}
