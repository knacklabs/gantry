const MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS = 2_000;
function pendingMemoryReviewLabel(count) {
    return `${count} pending memory review${count === 1 ? '' : 's'}`;
}
function pendingMemoryReviewNotice(count) {
    return `${pendingMemoryReviewLabel(count)} need${count === 1 ? 's' : ''} review`;
}
export async function countPendingReviewsForNotification(input) {
    try {
        const reviews = await input.memory.listPendingReviews(input.subject, {
            statementTimeoutMs: MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS,
        });
        return reviews.length;
    }
    catch {
        return 0;
    }
}
export function appendPendingReviewContextToError(error, pendingReviews) {
    if (pendingReviews <= 0) {
        return error instanceof Error ? error : new Error(String(error));
    }
    const baseMessage = error instanceof Error ? error.message : String(error || 'unknown error');
    const separator = /[.!?]\s*$/.test(baseMessage) ? ' ' : '. ';
    return new Error(`${baseMessage}${separator}${pendingMemoryReviewNotice(pendingReviews)}.`);
}
function numericSummaryValue(summary, key) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        return undefined;
    }
    const value = summary[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : undefined;
}
export function formatMemoryDreamingOutcome(run, queueResult) {
    if (queueResult.deduped) {
        return 'Memory dreaming was already running for this conversation.';
    }
    if (!run) {
        return 'Memory dreaming completed.';
    }
    if (run.status === 'failed') {
        const summary = run.summary && typeof run.summary === 'object'
            ? run.summary
            : {};
        const error = typeof summary.error === 'string' ? summary.error : '';
        const pendingReviews = numericSummaryValue(summary, 'pendingReviews') ?? 0;
        const base = error
            ? `Memory dreaming failed: ${error}${/[.!?]\s*$/.test(error) ? '' : '.'}`
            : 'Memory dreaming failed.';
        return appendPendingReviewNotice(base, pendingReviews);
    }
    const needsReview = numericSummaryValue(run.summary, 'needsReview') ?? 0;
    const pendingReviews = numericSummaryValue(run.summary, 'pendingReviews') ?? needsReview;
    const blocked = numericSummaryValue(run.summary, 'blocked') ?? 0;
    const issues = [];
    if (needsReview > 0)
        issues.push(`${needsReview} sent to review`);
    if (pendingReviews > needsReview) {
        issues.push(pendingMemoryReviewNotice(pendingReviews));
    }
    if (blocked > 0)
        issues.push(`${blocked} blocked`);
    if (issues.length > 0) {
        return `Memory dreaming needs attention: ${issues.join(', ')}.`;
    }
    return 'Memory dreaming completed.';
}
function appendPendingReviewNotice(summary, pendingReviews, alreadyReported = 0) {
    if (pendingReviews <= alreadyReported)
        return summary;
    return `${summary} ${pendingMemoryReviewNotice(pendingReviews)}.`;
}
