import type { MemoryReviewRecord } from './memory-types.js';
interface MemoryReviewRowLike {
    id: string;
    runId: string;
    appId: string;
    agentId: string;
    subjectType: string;
    subjectId: string;
    threadId: string | null;
    phase: string;
    proposalJson: string;
    status: string;
    itemVersionsJson: string;
    candidateVersionsJson: string;
    validationSummary: string;
    reviewerId: string | null;
    decision: string | null;
    editedValue: string | null;
    editedReason: string | null;
    applyOutcome: string | null;
    createdAt: string;
    updatedAt: string;
    decidedAt: string | null;
}
export declare function toMemoryReview(row: MemoryReviewRowLike): MemoryReviewRecord;
export {};
