import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export declare const DEFAULT_NONCE_TTL_MS: number;
export declare function isoPlusMs(iso: string, ms: number): string;
export declare function isUniqueViolation(err: unknown): boolean;
export declare function lockRunSlotKey(executor: CanonicalExecutor, slotKey: string): Promise<void>;
export type RunLeaseRow = typeof pgSchema.runLeasesPostgres.$inferSelect;
export declare function toRunLease(row: RunLeaseRow): RunLease;
/**
 * Claim a run/job lease inside an existing transaction. Locks the lease
 * history for the run and (when given) its job, refuses while a live lease
 * exists, expires lapsed active leases, and issues the new lease at a
 * strictly higher fencing version than anything seen for the run or job.
 * Callers must treat a unique violation as a lost concurrent claim.
 */
export declare function claimRunLeaseInTx(tx: CanonicalExecutor, input: {
    runId: string;
    jobId?: string | null;
    workerInstanceId: string;
    ttlMs: number;
    now?: string;
}): Promise<RunLease | null>;
export declare function isRunLeaseClaimConflict(err: unknown): boolean;
/**
 * Token-fenced terminal transition for a lease. Returns false when the
 * caller's lease is no longer the run's active lease (it expired or a newer
 * fencing version took over), in which case no terminal write may proceed.
 */
export declare function settleRunLeaseTx(executor: CanonicalExecutor, input: {
    runId: string;
    leaseToken: string;
    workerInstanceId?: string;
    fencingVersion?: number;
    outcome: 'completed' | 'failed' | 'released';
    allowAlreadySettled?: boolean;
}): Promise<boolean>;
