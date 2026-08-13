import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../schema/index.js';
import type { RuntimeEventType } from '../../../../domain/events/runtime-event-types.js';
import { CANONICAL_JOB_EVENT_TYPES } from './canonical-job-event-types.postgres.js';

// Batched primary read: one DISTINCT ON query returns the FIRST persisted
// event per run (0126 primary-denial rule) for a whole listing - never an
// N+1 per run and never a cap that can truncate the authoritative row.
export async function listFirstEventPerRun(
  db: NodePgDatabase<Record<string, unknown>>,
  limit: number,
  filters: { runIds: string[]; eventType?: RuntimeEventType; appId?: string },
): Promise<
  Array<{
    id: string;
    appId: string;
    runId: string;
    jobId: string;
    type: string;
    payloadJson: string;
    createdAt: string;
  }>
> {
  const rows = await db
    .selectDistinctOn([pgSchema.runtimeEventsPostgres.runId])
    .from(pgSchema.runtimeEventsPostgres)
    .where(
      and(
        inArray(pgSchema.runtimeEventsPostgres.runId, filters.runIds),
        filters.eventType
          ? eq(pgSchema.runtimeEventsPostgres.eventType, filters.eventType)
          : undefined,
        filters.appId
          ? eq(pgSchema.runtimeEventsPostgres.appId, filters.appId)
          : undefined,
      ),
    )
    .orderBy(
      asc(pgSchema.runtimeEventsPostgres.runId),
      asc(pgSchema.runtimeEventsPostgres.eventId),
    )
    .limit(limit);
  return rows.map((row) => ({
    id: String(row.eventId),
    appId: row.appId,
    runId: row.runId ?? '',
    jobId: row.jobId ?? '',
    type: row.eventType,
    payloadJson: row.payloadJson ?? '',
    createdAt: row.createdAt,
  }));
}

// Owner-app scoped event listing, extracted from the main repository to keep
// its file inside the architecture line budget; behavior is unchanged.
export async function listEventsForOwnerApp(
  db: NodePgDatabase<Record<string, unknown>>,
  limit: number,
  filters: {
    ownerAppId?: string;
    appId?: string;
    runId?: string;
    jobIds?: string[];
    eventType?: RuntimeEventType;
    sinceId?: number;
    since?: string;
  },
  joinClause: SQL,
  orderBy: SQL,
): Promise<
  Array<{
    id: string;
    appId: string;
    runId: string;
    jobId: string;
    type: string;
    payloadJson: string;
    createdAt: string;
  }>
> {
  const clauses = [
    eq(pgSchema.controlHttpSessionsPostgres.appId, filters.ownerAppId ?? ''),
    filters.appId
      ? eq(pgSchema.runtimeEventsPostgres.appId, filters.appId)
      : undefined,
    filters.runId
      ? eq(pgSchema.runtimeEventsPostgres.runId, filters.runId)
      : undefined,
    filters.jobIds?.length
      ? inArray(pgSchema.runtimeEventsPostgres.jobId, filters.jobIds)
      : undefined,
    filters.eventType
      ? eq(pgSchema.runtimeEventsPostgres.eventType, filters.eventType)
      : inArray(
          pgSchema.runtimeEventsPostgres.eventType,
          CANONICAL_JOB_EVENT_TYPES,
        ),
    filters.sinceId !== undefined
      ? gt(pgSchema.runtimeEventsPostgres.eventId, filters.sinceId)
      : undefined,
    filters.since
      ? gt(pgSchema.runtimeEventsPostgres.createdAt, filters.since)
      : undefined,
  ].filter(Boolean);
  const rows = await db
    .select({
      eventId: pgSchema.runtimeEventsPostgres.eventId,
      appId: pgSchema.runtimeEventsPostgres.appId,
      runId: pgSchema.runtimeEventsPostgres.runId,
      jobId: pgSchema.runtimeEventsPostgres.jobId,
      eventType: pgSchema.runtimeEventsPostgres.eventType,
      payloadJson: pgSchema.runtimeEventsPostgres.payloadJson,
      createdAt: pgSchema.runtimeEventsPostgres.createdAt,
    })
    .from(pgSchema.controlHttpSessionsPostgres)
    .innerJoin(pgSchema.canonicalJobsPostgres, joinClause)
    .innerJoin(
      pgSchema.runtimeEventsPostgres,
      eq(
        pgSchema.runtimeEventsPostgres.jobId,
        pgSchema.canonicalJobsPostgres.id,
      ),
    )
    .where(and(...clauses))
    .orderBy(orderBy)
    .limit(limit);
  return rows.map((row) => ({
    id: String(row.eventId),
    appId: row.appId,
    runId: row.runId ?? '',
    jobId: row.jobId ?? '',
    type: row.eventType,
    payloadJson: row.payloadJson ?? '',
    createdAt: row.createdAt,
  }));
}
