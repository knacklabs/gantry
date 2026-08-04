import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { normalizeSubject, subjectIdFor } from './app-memory-boundaries.js';
import { itemMatchesSubjectBoundary } from './app-memory-canonical-codec.js';
import { conversationIdForChannel } from './app-memory-service-record-mappers.js';
import type { AppMemoryItem, AppMemorySearchInput, AppMemorySearchResult, BlockedDreamDecision, DemoteDreamingMemoryInput, DeleteAppMemoryInput, DreamingRunStatus, DreamingTriggerInput, MemoryReviewDecisionInput, MemoryReviewPage, MemoryReviewRecord, MemoryBoundaryContext, MemoryEvidenceRecord, MemorySubjectType, PatchAppMemoryInput, SaveAppMemoryInput } from './memory-types.js';
type Db = NodePgDatabase<typeof pgSchema>;
export declare class AppMemoryService {
    private readonly explicitDb;
    private static singleton;
    static getInstance(): AppMemoryService;
    static resetForTest(): void;
    constructor(explicitDb?: Db | null);
    get db(): Db;
    private recallDeps;
    isEnabled(): boolean;
    private assertEnabled;
    recordEvidence(input: Partial<MemoryBoundaryContext> & {
        subjectType?: MemorySubjectType;
        subjectId?: string;
        sourceType: MemoryEvidenceRecord['sourceType'];
        sourceId?: string;
        actorId?: string;
        text: string;
        metadata?: Record<string, unknown>;
    }): Promise<MemoryEvidenceRecord>;
    save(input: SaveAppMemoryInput): Promise<AppMemoryItem>;
    list(input?: AppMemorySearchInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<AppMemoryItem[]>;
    search(input?: AppMemorySearchInput): Promise<AppMemorySearchResult[]>;
    recordRecallEvents: (input: AppMemorySearchInput, results: AppMemorySearchResult[]) => Promise<void>;
    searchReadOnly(input?: AppMemorySearchInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<AppMemorySearchResult[]>;
    listForHydrationReadOnly(input?: AppMemorySearchInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<AppMemoryItem[]>;
    searchForHydrationReadOnly(input?: AppMemorySearchInput, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
        allowEmbeddings?: boolean;
    }): Promise<AppMemorySearchResult[]>;
    patch(input: PatchAppMemoryInput): Promise<AppMemoryItem>;
    delete(input: DeleteAppMemoryInput): Promise<{
        deleted: boolean;
    }>;
    demoteDreamingPromoted(input: DemoteDreamingMemoryInput): Promise<{
        demoted: boolean;
    }>;
    demote(input: DemoteDreamingMemoryInput): Promise<{
        demoted: boolean;
    }>;
    continuityStatus(input?: Partial<MemoryBoundaryContext>): Promise<{
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
    continuitySummary(input?: Partial<MemoryBoundaryContext> & {
        deadlineAtMs?: number;
        nowMs?: number;
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<{
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
    triggerDreaming(input?: DreamingTriggerInput): Promise<DreamingRunStatus>;
    dreamingStatus(input?: Partial<MemoryBoundaryContext> & {
        subjectType?: MemorySubjectType;
        subjectId?: string;
    }, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<DreamingRunStatus[]>;
    listPendingReviews(input?: Partial<MemoryBoundaryContext> & {
        subjectType?: MemorySubjectType;
        subjectId?: string;
    }, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
    }): Promise<MemoryReviewRecord[]>;
    listRecentBlockedDreamDecisions(input?: Partial<MemoryBoundaryContext> & {
        subjectType?: MemorySubjectType;
        subjectId?: string;
    }, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
        limit?: number;
    }): Promise<BlockedDreamDecision[]>;
    listPendingReviewPage(input?: Partial<MemoryBoundaryContext> & {
        subjectType?: MemorySubjectType;
        subjectId?: string;
    }, options?: {
        signal?: AbortSignal;
        statementTimeoutMs?: number;
        limit?: number;
        offset?: number;
    }): Promise<MemoryReviewPage>;
    decideReview(input: MemoryReviewDecisionInput): Promise<MemoryReviewRecord>;
}
export declare const _testAppMemory: {
    conversationIdForChannel: typeof conversationIdForChannel;
    conflictingDreamPhases: typeof pgSchema.conflictingDreamPhases;
    itemMatchesSubjectBoundary: typeof itemMatchesSubjectBoundary;
    normalizeSubject: typeof normalizeSubject;
    subjectIdFor: typeof subjectIdFor;
};
export {};
