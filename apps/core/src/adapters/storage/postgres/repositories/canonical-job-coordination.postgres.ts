import { and, eq, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import type { Job } from '../../../../domain/types.js';
import {
  type CanonicalDb,
  jsonb,
} from './canonical-graph-repository.postgres.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';

export interface CanonicalJobCoordinationUpdate {
  consecutiveFailures?: number;
  incrementConsecutiveFailures?: boolean;
  maxConsecutiveFailures?: number | null;
  pauseReason?: string | null;
  setupState?: Job['setup_state'] | null;
}

export function coordinationColumnUpdate(
  update: CanonicalJobCoordinationUpdate,
): Record<string, unknown> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const setupState = update.setupState;
  return {
    ...(update.incrementConsecutiveFailures
      ? {
          consecutiveFailures: sql`${jobs.consecutiveFailures} + 1`,
        }
      : update.consecutiveFailures !== undefined
        ? { consecutiveFailures: update.consecutiveFailures }
        : {}),
    ...(update.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: update.maxConsecutiveFailures }
      : {}),
    ...(update.pauseReason !== undefined
      ? { pauseReason: update.pauseReason }
      : {}),
    ...(setupState !== undefined
      ? {
          setupState:
            setupState === null
              ? null
              : sql`CASE
                  WHEN ${jobs.setupState} ->> 'fingerprint' = ${setupState.fingerprint}
                    AND ${jobs.setupState} ? 'notified_fingerprint'
                  THEN jsonb_set(${jsonb(setupState)}, '{notified_fingerprint}', ${jobs.setupState} -> 'notified_fingerprint', true)
                  ELSE ${jsonb(setupState)}
                END`,
        }
      : {}),
  };
}

export async function markJobSetupNotified(
  db: CanonicalDb,
  id: string,
  expectedFingerprint: string,
): Promise<boolean> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const rows = await db
    .update(jobs)
    .set({
      setupState: sql`jsonb_set(${jobs.setupState}, '{notified_fingerprint}', to_jsonb(${expectedFingerprint}::text), true)`,
      updatedAt: currentIso(),
    })
    .where(
      and(
        eq(jobs.id, id),
        sql`${jobs.setupState} ->> 'fingerprint' = ${expectedFingerprint}`,
        sql`${jobs.setupState} ->> 'notified_fingerprint' IS DISTINCT FROM ${expectedFingerprint}`,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function clearJobSetupNotified(
  db: CanonicalDb,
  id: string,
  expectedFingerprint: string,
): Promise<boolean> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const rows = await db
    .update(jobs)
    .set({
      setupState: sql`jsonb_set(${jobs.setupState}, '{notified_fingerprint}', 'null'::jsonb, true)`,
      updatedAt: currentIso(),
    })
    .where(
      and(
        eq(jobs.id, id),
        sql`${jobs.setupState} ->> 'fingerprint' = ${expectedFingerprint}`,
        sql`${jobs.setupState} ->> 'notified_fingerprint' = ${expectedFingerprint}`,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function resumeSetupPausedJob(
  db: CanonicalDb,
  input: {
    jobId: string;
    expectedSetupCheckedAt: string;
    expectedPauseReason: string;
    nextRun: string;
    setupState: NonNullable<Job['setup_state']>;
  },
): Promise<boolean> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const rows = await db
    .update(jobs)
    .set({
      status: 'active',
      pauseReason: null,
      nextRunAt: input.nextRun,
      leaseRunId: null,
      leaseExpiresAt: null,
      updatedAt: input.nextRun,
      ...coordinationColumnUpdate({ setupState: input.setupState }),
    })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.status, 'paused'),
        eq(jobs.pauseReason, input.expectedPauseReason),
        sql`coalesce(
          (${jobs.setupState} ->> 'checked_at')::timestamptz,
          ${jobs.updatedAt}
        ) = ${input.expectedSetupCheckedAt}::timestamptz`,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function refreshSetupPausedJob(
  db: CanonicalDb,
  input: {
    jobId: string;
    expectedSetupCheckedAt: string;
    expectedPauseReason: string;
    setupState: NonNullable<Job['setup_state']>;
  },
): Promise<boolean> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const rows = await db
    .update(jobs)
    .set({
      nextRunAt: null,
      leaseRunId: null,
      leaseExpiresAt: null,
      updatedAt: currentIso(),
      ...coordinationColumnUpdate({ setupState: input.setupState }),
    })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.status, 'paused'),
        eq(jobs.pauseReason, input.expectedPauseReason),
        sql`coalesce(
          (${jobs.setupState} ->> 'checked_at')::timestamptz,
          ${jobs.updatedAt}
        ) = ${input.expectedSetupCheckedAt}::timestamptz`,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}
