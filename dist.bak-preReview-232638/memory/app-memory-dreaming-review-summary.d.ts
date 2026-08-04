import { countPendingMemoryReviews } from './app-memory-review.js';
export declare const MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS = 2000;
type CountPendingReviewsInput = Parameters<typeof countPendingMemoryReviews>[0];
export declare function safeCountPendingMemoryReviews(input: CountPendingReviewsInput & {
    signal?: AbortSignal;
}): Promise<number | undefined>;
export declare function withPendingReviews<T extends Record<string, unknown>>(summary: T, pendingReviews: number | undefined): T & {
    pendingReviews?: number;
};
export {};
