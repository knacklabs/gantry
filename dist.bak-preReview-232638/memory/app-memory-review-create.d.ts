import { validateMemoryReviewProposal } from './app-memory-review.js';
import type { DreamingRunStatus, MemoryLifecycleProposal, NormalizedMemorySubject } from './memory-types.js';
export type MemoryReviewDb = Parameters<typeof validateMemoryReviewProposal>[0]['db'];
type Db = MemoryReviewDb;
export type CreateMemoryReviewOutcome = {
    status: 'created' | 'pending_exists' | 'adjudicated' | 'invalid';
    reviewId: string;
    reason?: string;
};
export declare function createPendingMemoryReview(input: {
    db: Db;
    runId: string;
    subject: NormalizedMemorySubject;
    phase: DreamingRunStatus['phase'];
    proposal: MemoryLifecycleProposal;
}): Promise<CreateMemoryReviewOutcome>;
export {};
