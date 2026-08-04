import type { MemoryBoundaryContext, MemorySubjectType } from './memory-types.js';
export declare function summarizeDreamDecisions(decisions: Array<{
    action: string;
}>, dryRun: boolean, options?: {
    pendingReviews?: number;
}): {
    decisions: number;
    promoted: number;
    updated: number;
    retired: number;
    skipped: number;
    blocked: number;
    dryRunDecisions: number;
    needsReview: number;
    pendingReviews: number;
    dryRun: boolean;
};
export declare function hasDreamingStatusSubjectScope(input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
}): boolean;
