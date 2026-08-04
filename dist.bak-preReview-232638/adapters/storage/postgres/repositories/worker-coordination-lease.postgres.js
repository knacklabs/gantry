import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { nowIso as currentIso, nowMs, parseIso, toIso, } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
export const DEFAULT_NONCE_TTL_MS = 15 * 60_000;
export function isoPlusMs(iso, ms) {
    return toIso((parseIso(iso)?.getTime() ?? nowMs()) + ms);
}
export function isUniqueViolation(err) {
    // Drizzle wraps the pg driver error; the SQLSTATE lives on the cause chain.
    let current = err;
    for (let depth = 0; depth < 5; depth += 1) {
        if (!current || typeof current !== 'object')
            return false;
        const code = current.code;
        if (typeof code === 'string')
            return code === '23505';
        current = current.cause;
    }
    return false;
}
export async function lockRunSlotKey(executor, slotKey) {
    const lockKey = ['run_slots', slotKey].join(':');
    await executor.execute(sql `SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}
export function toRunLease(row) {
    return {
        runId: row.runId,
        jobId: row.jobId,
        workerInstanceId: row.workerInstanceId,
        leaseToken: row.leaseToken,
        fencingVersion: row.fencingVersion,
        status: row.status,
        claimedAt: row.claimedAt,
        expiresAt: row.expiresAt,
        heartbeatAt: row.heartbeatAt,
    };
}
/**
 * Claim a run/job lease inside an existing transaction. Locks the lease
 * history for the run and (when given) its job, refuses while a live lease
 * exists, expires lapsed active leases, and issues the new lease at a
 * strictly higher fencing version than anything seen for the run or job.
 * Callers must treat a unique violation as a lost concurrent claim.
 */
export async function claimRunLeaseInTx(tx, input) {
    const now = input.now ?? currentIso();
    const expiresAt = isoPlusMs(now, input.ttlMs);
    const leases = pgSchema.runLeasesPostgres;
    const existing = await tx
        .select()
        .from(leases)
        .where(input.jobId
        ? or(eq(leases.runId, input.runId), eq(leases.jobId, input.jobId))
        : eq(leases.runId, input.runId))
        .for('update');
    const nowEpochMs = parseIso(now)?.getTime() ?? nowMs();
    const leaseExpiryMs = (lease) => parseIso(lease.expiresAt)?.getTime() ?? 0;
    const live = existing.find((lease) => lease.status === 'active' && leaseExpiryMs(lease) > nowEpochMs);
    if (live)
        return null;
    const lapsed = existing.filter((lease) => lease.status === 'active' && leaseExpiryMs(lease) <= nowEpochMs);
    if (lapsed.length > 0) {
        await tx
            .update(leases)
            .set({ status: 'expired' })
            .where(inArray(leases.leaseToken, lapsed.map((lease) => lease.leaseToken)));
    }
    const previousFencingVersion = existing.reduce((max, lease) => Math.max(max, lease.fencingVersion), 0);
    const recoveredFromExpiredLease = lapsed.length > 0 ||
        existing.some((lease) => lease.runId === input.runId && lease.status === 'expired') ||
        existing.some((lease) => input.jobId &&
            lease.jobId === input.jobId &&
            lease.status === 'expired' &&
            lease.fencingVersion === previousFencingVersion);
    const fencingVersion = previousFencingVersion + 1;
    const lease = {
        runId: input.runId,
        jobId: input.jobId ?? null,
        workerInstanceId: input.workerInstanceId,
        leaseToken: randomUUID(),
        fencingVersion,
        status: 'active',
        claimedAt: now,
        expiresAt,
        heartbeatAt: now,
    };
    await tx.insert(leases).values(lease);
    return { ...toRunLease(lease), recoveredFromExpiredLease };
}
export function isRunLeaseClaimConflict(err) {
    return isUniqueViolation(err);
}
/**
 * Token-fenced terminal transition for a lease. Returns false when the
 * caller's lease is no longer the run's active lease (it expired or a newer
 * fencing version took over), in which case no terminal write may proceed.
 */
export async function settleRunLeaseTx(executor, input) {
    const hasFullFence = input.workerInstanceId !== undefined || input.fencingVersion !== undefined;
    if (hasFullFence &&
        (!input.workerInstanceId || input.fencingVersion === undefined)) {
        throw new Error('Run lease settlement fence requires workerInstanceId and fencingVersion.');
    }
    const now = currentIso();
    const rows = await executor
        .update(pgSchema.runLeasesPostgres)
        .set({ status: input.outcome })
        .where(and(eq(pgSchema.runLeasesPostgres.runId, input.runId), eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken), ...(input.workerInstanceId
        ? [
            eq(pgSchema.runLeasesPostgres.workerInstanceId, input.workerInstanceId),
            eq(pgSchema.runLeasesPostgres.fencingVersion, input.fencingVersion),
        ]
        : []), eq(pgSchema.runLeasesPostgres.status, 'active'), gt(pgSchema.runLeasesPostgres.expiresAt, now)))
        .returning({ runId: pgSchema.runLeasesPostgres.runId });
    if (rows.length > 0)
        return true;
    if (!input.allowAlreadySettled)
        return false;
    const existing = await executor
        .select({ runId: pgSchema.runLeasesPostgres.runId })
        .from(pgSchema.runLeasesPostgres)
        .where(and(eq(pgSchema.runLeasesPostgres.runId, input.runId), eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken), ...(input.workerInstanceId
        ? [
            eq(pgSchema.runLeasesPostgres.workerInstanceId, input.workerInstanceId),
            eq(pgSchema.runLeasesPostgres.fencingVersion, input.fencingVersion),
        ]
        : []), inArray(pgSchema.runLeasesPostgres.status, [
        'completed',
        'failed',
        'released',
    ])))
        .limit(1);
    return existing.length > 0;
}
