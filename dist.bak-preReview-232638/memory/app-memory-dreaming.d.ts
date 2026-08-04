import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { AppMemoryItem, DreamDecisionAction, MemoryLifecycleProposal, DreamingRunStatus, NormalizedMemorySubject, SaveAppMemoryInput } from './memory-types.js';
import { type CreatePendingReview } from './app-memory-dreaming-review-routing.js';
type Db = NodePgDatabase<typeof pgSchema>;
type MemoryItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
type DreamEmbeddingResult = {
    status: 'stored' | 'disabled' | 'retryable';
    reason?: string;
};
export declare function runAppMemoryDreamPass(input: {
    db: Db;
    runId: string;
    subject: NormalizedMemorySubject;
    phase: DreamingRunStatus['phase'];
    dryRun: boolean;
    signal?: AbortSignal;
    remainingTimeoutMs?: () => number | undefined;
    listItems: () => Promise<Array<{
        row: MemoryItemRow;
    }>>;
    save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
    retire: (input: {
        id: string;
        isAdminWrite?: boolean;
    } & Partial<NormalizedMemorySubject>) => Promise<{
        deleted: boolean;
    }>;
    storeDreamEmbedding?: (input: {
        item: AppMemoryItem;
        contentHash: string;
    }) => Promise<DreamEmbeddingResult>;
    proposeDreaming?: (input: {
        evidence: (typeof pgSchema.memoryEvidencePostgres.$inferSelect)[];
        candidates: (typeof pgSchema.memoryCandidatesPostgres.$inferSelect)[];
        activeItems: MemoryItemRow[];
    }) => Promise<MemoryLifecycleProposal[]>;
    proposeConsolidation?: (input: {
        activeItems: MemoryItemRow[];
    }) => Promise<MemoryLifecycleProposal[]>;
    createPendingReview?: CreatePendingReview;
    /**
     * Optional detection pass (the pattern-candidate loop). Runs on the deep
     * phase after consolidation; detects repeated work and upserts pattern
     * candidates. It only writes `detected` candidates — never proposes a skill.
     */
    detectPatternCandidates?: (input: {
        subject: NormalizedMemorySubject;
        evidence: (typeof pgSchema.memoryEvidencePostgres.$inferSelect)[];
        db: Db;
        signal?: AbortSignal;
    }) => Promise<void>;
}): Promise<Array<{
    action: DreamDecisionAction;
}>>;
export {};
