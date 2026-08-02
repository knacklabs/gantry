import type { AppMemoryItem, BlockedDreamDecision, MemoryBoundaryContext, MemoryReviewRecord, MemorySubjectType } from './memory-types.js';
type ContinuityMemoryPort = {
    dreamingStatus(input?: ContinuityInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<ContinuityRun[]>;
    listPendingReviews(input?: ContinuityInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<MemoryReviewRecord[]>;
    list(input?: Partial<MemoryBoundaryContext> & {
        limit?: number;
    }, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<AppMemoryItem[]>;
    listRecentBlockedDreamDecisions?(input?: ContinuityInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
        limit?: number;
    }): Promise<BlockedDreamDecision[]>;
};
type ContinuityInput = Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
    deadlineAtMs?: number;
    nowMs?: number;
    signal?: AbortSignal;
    statementTimeoutMs?: number;
};
type ContinuityRun = {
    completedAt?: string | null;
    startedAt: string;
    status: string;
    phase: string;
    summary: unknown;
};
export declare function buildAppMemoryContinuityStatus(memory: ContinuityMemoryPort, input?: Partial<MemoryBoundaryContext>): Promise<{
    lastDreamRun: {
        at: string;
        status: string;
        phase: string;
        summary: Record<string, unknown>;
    } | undefined;
    lastInjectedBlock?: {
        subject: string;
        bytes: number;
        at: string;
    } | undefined;
    subject: import("./memory-types.js").NormalizedMemorySubject;
    stagedCount: number;
    promotedCount: number;
    needsReviewCount: number;
}>;
export declare function buildAppMemoryContinuitySummary(memory: ContinuityMemoryPort, input?: ContinuityInput): Promise<{
    overall_status: string;
    subject: import("./memory-types.js").NormalizedMemorySubject;
    active_count: number;
    staged_count: number;
    promoted_count: number;
    needs_review_count: number;
    last_injected_block: {
        subject: string;
        bytes: number;
        at: string;
    } | undefined;
    last_dream_run: {
        at: string;
        status: string;
        phase: string;
        summary: Record<string, unknown>;
    } | undefined;
    sections: {
        recent_decisions: {
            reason?: string | undefined;
            status: string;
            count: number;
            items: unknown[];
        };
        active_paused_jobs: {
            reason?: string | undefined;
            status: string;
            count: number;
            items: unknown[];
        };
        last_runs: {
            reason?: string | undefined;
            status: string;
            count: number;
            items: unknown[];
        };
        last_dream_summary: {
            reason?: string | undefined;
            status: string;
            count: number;
            items: unknown[];
        };
        blocked_dream_decisions: {
            reason?: string | undefined;
            status: string;
            count: number;
            items: unknown[];
        };
        issue_index: {
            reason?: string | undefined;
            status: string;
            count: number;
            items: unknown[];
        };
    };
}>;
export {};
