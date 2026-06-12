import { and, eq } from 'drizzle-orm';

import type { JobRun } from '../../../../domain/repositories/domain-types.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import { parseIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  parseJson,
  type CanonicalDb,
  type CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import {
  claimRunLeaseInTx,
  isRunLeaseClaimConflict,
} from './worker-coordination-lease.postgres.js';

/**
 * Transactionally claim a due job run for a worker: insert the run, issue the
 * worker's run lease (token + fencing version), and flip the job to running.
 * Returns null when the job is not claimable or another worker won the claim.
 */
export async function claimDueCanonicalJobRunStart(input: {
  db: CanonicalDb;
  jobId: string;
  run: JobRun;
  leaseExpiresAt: string;
  workerInstanceId: string;
  requireNextRun?: boolean;
  insertRun: (run: JobRun, tx: CanonicalExecutor) => Promise<boolean>;
}): Promise<RunLease | null> {
  try {
    return await input.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pgSchema.canonicalJobsPostgres)
        .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
        .for('update')
        .limit(1);
      const job = rows[0];
      if (!job) return null;
      const target = parseJson<{ recoveryIntent?: { state?: unknown } }>(
        job.targetJson,
        {},
      );
      if (
        job.status !== 'active' ||
        target.recoveryIntent?.state === 'running' ||
        (input.requireNextRun !== false &&
          job.nextRunAt !== input.run.scheduled_for)
      ) {
        return null;
      }
      const existingRuns = await tx
        .select()
        .from(pgSchema.agentRunsPostgres)
        .where(eq(pgSchema.agentRunsPostgres.id, input.run.run_id))
        .for('update')
        .limit(1);
      const existingRun = existingRuns[0] ?? null;
      if (existingRun && existingRun.jobId !== input.jobId) return null;
      if (existingRun) {
        if (!['running', 'timeout'].includes(existingRun.status)) return null;
        const expiredLeaseRows = await tx
          .select({ runId: pgSchema.runLeasesPostgres.runId })
          .from(pgSchema.runLeasesPostgres)
          .where(
            and(
              eq(pgSchema.runLeasesPostgres.runId, input.run.run_id),
              eq(pgSchema.runLeasesPostgres.status, 'expired'),
            ),
          )
          .limit(1);
        if (expiredLeaseRows.length === 0) return null;
      }
      const inserted = existingRun
        ? false
        : await input.insertRun(input.run, tx);
      if (!existingRun && !inserted) return null;
      const startedAtMs =
        parseIso(input.run.started_at)?.getTime() ?? Date.now();
      const leaseExpiresAtMs =
        parseIso(input.leaseExpiresAt)?.getTime() ?? startedAtMs;
      const lease = await claimRunLeaseInTx(tx, {
        runId: input.run.run_id,
        jobId: input.jobId,
        workerInstanceId: input.workerInstanceId,
        ttlMs: Math.max(1_000, leaseExpiresAtMs - startedAtMs),
        now: input.run.started_at,
      });
      if (!lease) return null;
      if (!inserted) {
        await tx
          .update(pgSchema.agentRunsPostgres)
          .set({
            executionProviderId: input.run.execution_provider_id,
            providerRunId: input.run.provider_run_id ?? null,
            providerSessionId: input.run.provider_session_id ?? null,
            workerId: input.run.worker_id ?? null,
            leaseOwner: input.run.lease_owner ?? null,
            leaseExpiresAt: input.leaseExpiresAt,
            createdAt: input.run.scheduled_for || input.run.started_at,
            status: 'running',
            startedAt: input.run.started_at,
            endedAt: null,
            resultSummary: null,
            errorSummary: null,
            notifiedAt: null,
          })
          .where(eq(pgSchema.agentRunsPostgres.id, input.run.run_id));
      }
      await tx
        .update(pgSchema.canonicalJobsPostgres)
        .set({
          status: 'running',
          leaseRunId: input.run.run_id,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.run.started_at,
        })
        .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId));
      return lease;
    });
  } catch (err) {
    if (isRunLeaseClaimConflict(err)) return null;
    throw err;
  }
}
