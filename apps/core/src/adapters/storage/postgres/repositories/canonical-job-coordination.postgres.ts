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

export const JOB_SETUP_NOTIFY_CLAIM_TTL_MS = 5 * 60_000;

export interface JobSetupNotificationClaimOptions {
  nowIso?: string;
  claimTtlMs?: number;
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
                  THEN jsonb_set(
                    CASE
                      WHEN ${jobs.setupState} ? 'notified_fingerprint'
                      THEN jsonb_set(${jsonb(setupState)}, '{notified_fingerprint}', ${jobs.setupState} -> 'notified_fingerprint', true)
                      ELSE ${jsonb(setupState)}
                    END,
                    '{notify_claim_at}',
                    CASE
                      WHEN ${jobs.setupState} ? 'notify_claim_at'
                      THEN ${jobs.setupState} -> 'notify_claim_at'
                      ELSE 'null'::jsonb
                    END,
                    true
                  )
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
  options: JobSetupNotificationClaimOptions = {},
): Promise<string | null> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const claimAt = options.nowIso ?? currentIso();
  const staleBefore = new Date(
    Date.parse(claimAt) - (options.claimTtlMs ?? JOB_SETUP_NOTIFY_CLAIM_TTL_MS),
  ).toISOString();
  const rows = await db
    .update(jobs)
    .set({
      setupState: sql`jsonb_set(
        jsonb_set(${jobs.setupState}, '{notified_fingerprint}', to_jsonb(${expectedFingerprint}::text), true),
        '{notify_claim_at}',
        to_jsonb(${claimAt}::text),
        true
      )`,
      updatedAt: claimAt,
    })
    .where(
      and(
        eq(jobs.id, id),
        sql`${jobs.setupState} ->> 'fingerprint' = ${expectedFingerprint}`,
        sql`(
          ${jobs.setupState} ->> 'notified_fingerprint' IS DISTINCT FROM ${expectedFingerprint}
          OR (
            ${jobs.setupState} ->> 'notified_fingerprint' = ${expectedFingerprint}
            AND ${jobs.setupState} ->> 'notify_claim_at' IS NOT NULL
            AND (${jobs.setupState} ->> 'notify_claim_at')::timestamptz < ${staleBefore}::timestamptz
          )
        )`,
      ),
    )
    .returning({
      claimAt: sql<string>`${jobs.setupState} ->> 'notify_claim_at'`,
    });
  return rows[0]?.claimAt ?? null;
}

export async function confirmJobSetupNotified(
  db: CanonicalDb,
  id: string,
  expectedFingerprint: string,
  claimAt: string,
): Promise<void> {
  const jobs = pgSchema.canonicalJobsPostgres;
  await db
    .update(jobs)
    .set({
      setupState: sql`jsonb_set(${jobs.setupState}, '{notify_claim_at}', 'null'::jsonb, true)`,
      updatedAt: currentIso(),
    })
    .where(
      and(
        eq(jobs.id, id),
        sql`${jobs.setupState} ->> 'fingerprint' = ${expectedFingerprint}`,
        sql`${jobs.setupState} ->> 'notified_fingerprint' = ${expectedFingerprint}`,
        sql`${jobs.setupState} ->> 'notify_claim_at' = ${claimAt}`,
      ),
    );
}

export async function clearJobSetupNotified(
  db: CanonicalDb,
  id: string,
  expectedFingerprint: string,
  claimAt: string,
): Promise<void> {
  const jobs = pgSchema.canonicalJobsPostgres;
  await db
    .update(jobs)
    .set({
      setupState: sql`jsonb_set(
        jsonb_set(${jobs.setupState}, '{notified_fingerprint}', 'null'::jsonb, true),
        '{notify_claim_at}',
        'null'::jsonb,
        true
      )`,
      updatedAt: currentIso(),
    })
    .where(
      and(
        eq(jobs.id, id),
        sql`${jobs.setupState} ->> 'fingerprint' = ${expectedFingerprint}`,
        sql`${jobs.setupState} ->> 'notified_fingerprint' = ${expectedFingerprint}`,
        sql`${jobs.setupState} ->> 'notify_claim_at' = ${claimAt}`,
      ),
    );
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
