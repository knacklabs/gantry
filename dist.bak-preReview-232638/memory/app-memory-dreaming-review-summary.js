import { countPendingMemoryReviews } from './app-memory-review.js';
export const MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS = 2_000;
export async function safeCountPendingMemoryReviews(input) {
    try {
        input.signal?.throwIfAborted();
        const pendingReviews = await countPendingMemoryReviews({
            db: input.db,
            subject: input.subject,
            statementTimeoutMs: input.statementTimeoutMs ?? MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS,
        });
        input.signal?.throwIfAborted();
        return pendingReviews;
    }
    catch {
        return undefined;
    }
}
export function withPendingReviews(summary, pendingReviews) {
    if (pendingReviews === undefined)
        return summary;
    return { ...summary, pendingReviews };
}
