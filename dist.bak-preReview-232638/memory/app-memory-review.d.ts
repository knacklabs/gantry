import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { AppMemoryItem, DeleteAppMemoryInput, MemoryLifecycleProposal, MemoryReviewDecisionInput, MemoryReviewPage, MemoryReviewRecord, NormalizedMemorySubject, PatchAppMemoryInput, SaveAppMemoryInput } from './memory-types.js';
type Db = NodePgDatabase<typeof pgSchema>;
export declare function countPendingMemoryReviews(input: {
    db: Db;
    subject: NormalizedMemorySubject;
    statementTimeoutMs?: number;
}): Promise<number>;
export declare function listPendingMemoryReviews(input: {
    db: Db;
    subject: NormalizedMemorySubject;
    statementTimeoutMs?: number;
    limit?: number;
    offset?: number;
}): Promise<MemoryReviewRecord[]>;
export declare function listPendingMemoryReviewPage(input: {
    db: Db;
    subject: NormalizedMemorySubject;
    statementTimeoutMs?: number;
    limit?: number;
    offset?: number;
}): Promise<MemoryReviewPage>;
export declare function decideMemoryReview(input: {
    db: Db;
    subject: NormalizedMemorySubject;
    decision: MemoryReviewDecisionInput;
    save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
    patch: (value: PatchAppMemoryInput) => Promise<AppMemoryItem>;
    delete: (value: DeleteAppMemoryInput) => Promise<{
        deleted: boolean;
    }>;
}): Promise<MemoryReviewRecord>;
export declare function validateMemoryReviewProposal(input: {
    db: Db;
    subject: NormalizedMemorySubject;
    proposal: MemoryLifecycleProposal;
    expectedItemVersions?: Record<string, number>;
    expectedCandidateVersions?: Record<string, string>;
}): Promise<{
    ok: boolean;
    reason: string;
    itemVersions: Record<string, number>;
    candidateVersions: Record<string, string>;
    contentFingerprint?: string;
}>;
export {};
