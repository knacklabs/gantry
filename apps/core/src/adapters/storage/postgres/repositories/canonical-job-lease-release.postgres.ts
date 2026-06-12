import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

/**
 * Stale recovery only: releases job leases whose expiry has lapsed. Live
 * leases are never released here — startup recovery must not interrupt runs
 * that another worker still holds.
 */
export async function releaseStaleCanonicalJobLeases(
  db: CanonicalDb,
  nowIso: string,
): Promise<ReleasedStaleJobLease[]> {
  return db.transaction(async (tx) => {
    const jobs = pgSchema.canonicalJobsPostgres;
    const runs = pgSchema.agentRunsPostgres;
    // A heartbeat-renewed run lease keeps the job alive even past the job's
    // original lease window; only release once both have lapsed.
    const noLiveRunLease = sql`NOT EXISTS (
      SELECT 1 FROM run_leases rl
      WHERE rl.run_id = ${jobs.leaseRunId}
        AND rl.status = 'active'
        AND rl.expires_at > ${nowIso}
    )`;
    const stalePredicate = and(
      eq(jobs.status, 'running'),
      isNotNull(jobs.leaseExpiresAt),
      lt(jobs.leaseExpiresAt, nowIso),
      noLiveRunLease,
    );
    const staleJobs = await tx
      .select({ id: jobs.id, leaseRunId: jobs.leaseRunId })
      .from(jobs)
      .where(stalePredicate);
    if (staleJobs.length === 0) return [];
    const releasedJobs = await tx
      .update(jobs)
      .set({
        status: 'active',
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          inArray(
            jobs.id,
            staleJobs.map((job) => job.id),
          ),
          stalePredicate,
        ),
      )
      .returning({ id: jobs.id });
    const releasedJobIds = new Set(releasedJobs.map((job) => job.id));
    const releasedStaleJobs = staleJobs.filter((job) =>
      releasedJobIds.has(job.id),
    );
    const runIds = releasedStaleJobs
      .map((job) => job.leaseRunId)
      .filter((runId): runId is string => Boolean(runId));
    const timedOutRunIds = new Set<string>();
    if (runIds.length > 0) {
      const timedOutRows = await tx
        .update(runs)
        .set({
          status: 'timeout',
          endedAt: nowIso,
          errorSummary: 'Scheduler run lease expired before completion.',
        })
        .where(and(inArray(runs.id, runIds), eq(runs.status, 'running')))
        .returning({ id: runs.id });
      for (const row of timedOutRows) timedOutRunIds.add(row.id);
      // The expired worker's run lease is fenced out in the same transaction
      // so its lease token can no longer settle or write terminal state.
      await tx
        .update(pgSchema.runLeasesPostgres)
        .set({ status: 'expired' })
        .where(
          and(
            inArray(pgSchema.runLeasesPostgres.runId, runIds),
            eq(pgSchema.runLeasesPostgres.status, 'active'),
          ),
        );
    }
    return releasedStaleJobs.map((job) => ({
      jobId: job.id,
      runId: job.leaseRunId,
      releasedAt: nowIso,
      runTimedOut: job.leaseRunId ? timedOutRunIds.has(job.leaseRunId) : false,
      reason: 'lease_expired' as const,
    }));
  });
}
