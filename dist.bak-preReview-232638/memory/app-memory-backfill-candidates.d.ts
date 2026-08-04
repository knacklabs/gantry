import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
type Db = NodePgDatabase<typeof pgSchema>;
/** Default window after which a `processing` row is treated as stuck/abandoned. */
export declare const PROCESSING_LEASE_MS: number;
export interface BackfillCandidate {
    itemId: string;
    key: string;
    value: string;
    why: string | null;
    contentHash: string;
    text: string;
}
export interface CandidateScanResult {
    candidates: BackfillCandidate[];
    skippedReady: number;
    scanned: number;
}
/**
 * Find active memory items in scope that still need an embedding for the given
 * (provider, model, dimensions): missing, stale content hash, retryable rows
 * past `resume_after`, queued rows, and `processing` rows whose lease expired.
 * Rows already `ready` for the current content hash (and `submitted`/blocked
 * rows for the current hash) are skipped. Oldest items are returned first.
 */
export declare function selectBackfillCandidates(db: Db, scope: {
    appId: string;
    agentId?: string | null;
    provider: string;
    model: string;
    dimensions: number;
    scanLimit: number;
    now: string;
    processingLeaseMs?: number;
}): Promise<CandidateScanResult>;
export {};
