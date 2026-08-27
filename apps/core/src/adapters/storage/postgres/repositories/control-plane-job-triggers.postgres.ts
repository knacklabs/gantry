import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import {
  mapTrigger,
  type CanonicalControlRow,
} from '../schema/control-plane-canonical.postgres.js';
import type { JobTriggerRecord } from '../schema/control-plane-records.postgres.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export class PostgresJobTriggerRepository {
  constructor(private readonly db: CanonicalDb) {}

  async create(input: {
    jobId: string;
    triggerId?: string;
    requestedBy?: string;
  }): Promise<JobTriggerRecord> {
    const job = await this.db
      .select({ appId: pgSchema.canonicalJobsPostgres.appId })
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
      .limit(1);
    const appId = job[0]?.appId ?? 'default';
    const now = currentIso();
    const triggerId = input.triggerId ?? randomUUID();
    const requestedBy = input.requestedBy ?? 'sdk';
    const rows = await this.db
      .insert(pgSchema.canonicalJobTriggersPostgres)
      .values({
        id: triggerId,
        appId,
        jobId: input.jobId,
        runId: null,
        requestedBy,
        requestedAt: now,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: pgSchema.canonicalJobTriggersPostgres.id,
      })
      .returning();
    if (rows[0]) return mapTrigger(rows[0] as CanonicalControlRow);
    const [existing] = await this.db
      .select()
      .from(pgSchema.canonicalJobTriggersPostgres)
      .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId))
      .limit(1);
    if (
      !existing ||
      existing.jobId !== input.jobId ||
      existing.requestedBy !== requestedBy
    ) {
      throw new Error('Job trigger idempotency scope does not match.');
    }
    return mapTrigger(existing as CanonicalControlRow);
  }

  async bindPendingToRun(
    jobId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    return this.db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(pgSchema.canonicalJobTriggersPostgres)
        .where(
          and(
            eq(pgSchema.canonicalJobTriggersPostgres.jobId, jobId),
            eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending'),
          ),
        )
        .orderBy(
          asc(pgSchema.canonicalJobTriggersPostgres.requestedAt),
          asc(pgSchema.canonicalJobTriggersPostgres.id),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!pending) return undefined;
      const rows = await tx
        .update(pgSchema.canonicalJobTriggersPostgres)
        .set({
          runId,
          status: 'claimed',
          updatedAt: currentIso(),
        })
        .where(
          and(
            eq(pgSchema.canonicalJobTriggersPostgres.id, pending.id),
            eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending'),
          ),
        )
        .returning();
      return rows[0] ? mapTrigger(rows[0] as CanonicalControlRow) : undefined;
    });
  }

  async bindToRun(
    triggerId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.db
      .update(pgSchema.canonicalJobTriggersPostgres)
      .set({
        runId,
        status: 'claimed',
        updatedAt: currentIso(),
      })
      .where(
        and(
          eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId),
          eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending'),
        ),
      )
      .returning();
    return rows[0] ? mapTrigger(rows[0] as CanonicalControlRow) : undefined;
  }

  async markCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    await this.db
      .update(pgSchema.canonicalJobTriggersPostgres)
      .set({ status, updatedAt: currentIso() })
      .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId));
  }

  async getById(triggerId: string): Promise<JobTriggerRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.canonicalJobTriggersPostgres)
      .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId))
      .limit(1);
    return rows[0] ? mapTrigger(rows[0] as CanonicalControlRow) : undefined;
  }
}
