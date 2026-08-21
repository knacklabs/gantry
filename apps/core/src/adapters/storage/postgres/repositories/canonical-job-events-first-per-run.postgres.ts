import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
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

// Set-based per-job read for setup delivery notices: ONE window-function
// query returns up to perJobLimit newest events per job - never an N+1
// fan-out per listed job and never a shared cap one job can starve.
export async function listLatestEventsPerJob(
  db: NodePgDatabase<Record<string, unknown>>,
  filters: {
    appId: string;
    jobIds: string[];
    eventType: RuntimeEventType;
    perJobLimit: number;
  },
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
  if (filters.jobIds.length === 0) return [];
  // Restrict to each job's LATEST prompt IN SQL: late truthful events for
  // retired prompts would otherwise fill the newest-N window and evict the
  // current prompt's own outcome before app-side filtering could run. The
  // latest prompt has at most one event per delivery generation plus one
  // expiry, so the per-job cap can never truncate it.
  const latestPrompt = db
    .selectDistinctOn([pgSchema.permissionPromptsPostgres.jobId], {
      jobId: pgSchema.permissionPromptsPostgres.jobId,
      promptId: pgSchema.permissionPromptsPostgres.id,
    })
    .from(pgSchema.permissionPromptsPostgres)
    .where(
      and(
        eq(pgSchema.permissionPromptsPostgres.appId, filters.appId),
        inArray(pgSchema.permissionPromptsPostgres.jobId, filters.jobIds),
      ),
    )
    .orderBy(
      pgSchema.permissionPromptsPostgres.jobId,
      sql`${pgSchema.permissionPromptsPostgres.createdAt} desc`,
      sql`${pgSchema.permissionPromptsPostgres.id} desc`,
    )
    .as('latest_prompt');
  const ranked = db
    .select({
      eventId: pgSchema.runtimeEventsPostgres.eventId,
      appId: pgSchema.runtimeEventsPostgres.appId,
      runId: pgSchema.runtimeEventsPostgres.runId,
      jobId: pgSchema.runtimeEventsPostgres.jobId,
      eventType: pgSchema.runtimeEventsPostgres.eventType,
      payloadJson: pgSchema.runtimeEventsPostgres.payloadJson,
      createdAt: pgSchema.runtimeEventsPostgres.createdAt,
      rn: sql<number>`row_number() over (partition by ${pgSchema.runtimeEventsPostgres.jobId} order by ${pgSchema.runtimeEventsPostgres.eventId} desc)`.as(
        'rn',
      ),
    })
    .from(pgSchema.runtimeEventsPostgres)
    .innerJoin(
      latestPrompt,
      and(
        eq(latestPrompt.jobId, pgSchema.runtimeEventsPostgres.jobId),
        sql`${pgSchema.runtimeEventsPostgres.payloadJson}::jsonb ->> 'prompt_id' = ${latestPrompt.promptId}`,
      ),
    )
    .where(
      and(
        eq(pgSchema.runtimeEventsPostgres.appId, filters.appId),
        inArray(pgSchema.runtimeEventsPostgres.jobId, filters.jobIds),
        eq(pgSchema.runtimeEventsPostgres.eventType, filters.eventType),
      ),
    )
    .as('ranked_events');
  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rn, filters.perJobLimit));
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
