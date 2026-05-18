import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import type { JobRun } from '../../../../domain/repositories/domain-types.js';
// prettier-ignore
import type { JobListFilters, JobRunListFilters, ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
// prettier-ignore
import { RUNTIME_EVENT_TYPES, type RuntimeEventType } from '../../../../domain/events/runtime-event-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  PostgresCanonicalGraphRepository,
  configVersionIdForAgent,
  jsonb,
  jsonText,
  parseJson,
} from './canonical-graph-repository.postgres.js';
// prettier-ignore
import { releaseInterruptedCanonicalJobLeases, releaseStaleCanonicalJobLeases } from './canonical-job-lease-release.postgres.js';
import { insertCanonicalJobRun } from './canonical-job-run-insert.postgres.js';

export interface CanonicalJobRecord {
  id: string;
  agentId: string | null;
  name: string;
  prompt: string;
  model: string | null;
  scheduleJson: string;
  status: string;
  targetJson: string;
  silent: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  leaseRunId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecordInput {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  model: string | null;
  scheduleJson: string;
  status: string;
  targetJson: string;
  silent: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  leaseRunId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalRunRecord {
  id: string;
  shortId: number | null;
  jobId: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  resultSummary: string | null;
  errorSummary: string | null;
  notifiedAt: string | null;
}

export interface CanonicalJobEventRecord {
  id: string;
  appId: string;
  runId: string;
  jobId: string;
  type: string;
  payloadJson: string;
  createdAt: string;
}

const CANONICAL_JOB_EVENT_TYPES = [
  RUNTIME_EVENT_TYPES.JOB_TRIGGERED,
  RUNTIME_EVENT_TYPES.JOB_RUN_STARTED,
  RUNTIME_EVENT_TYPES.JOB_STARTED,
  RUNTIME_EVENT_TYPES.JOB_STREAMING,
  RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
  RUNTIME_EVENT_TYPES.JOB_SETUP_REQUIRED,
  RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
  RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
  RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
  RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
  RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED,
  RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
  RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED,
  RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
  RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
  RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
  RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
  RUNTIME_EVENT_TYPES.RUN_COMPLETED,
  RUNTIME_EVENT_TYPES.RUN_FAILED,
  RUNTIME_EVENT_TYPES.RUN_TIMEOUT,
  RUNTIME_EVENT_TYPES.RUN_DEAD_LETTERED,
  RUNTIME_EVENT_TYPES.JOB_COMPLETED,
  RUNTIME_EVENT_TYPES.JOB_FAILED,
  RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED,
  RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
] as const;

function canonicalAgentId(agentId: string): string {
  const trimmed = agentId.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

function kindClause(
  kind: NonNullable<JobListFilters['kind']>,
  scheduleJson: unknown,
) {
  if (kind === 'manual') {
    return sql`${scheduleJson} ->> 'type' = 'manual'`;
  }
  if (kind === 'once') {
    return sql`${scheduleJson} ->> 'type' = 'once'`;
  }
  return sql`${scheduleJson} ->> 'type' in ('cron', 'interval')`;
}

function ownedByAppClause(jobId: unknown, ownerAppId?: string) {
  return ownerAppId
    ? sql`exists (
        select 1
        from ${pgSchema.canonicalJobsPostgres} owned_job
        join ${pgSchema.controlHttpSessionsPostgres} app_session
          on ((owned_job.target_json #>> '{executionContext,sessionId}' is not null and app_session.session_id = owned_job.target_json #>> '{executionContext,sessionId}')
            or (owned_job.target_json #>> '{executionContext,sessionId}' is null and app_session.external_ref_json->>'chatJid' = owned_job.target_json #>> '{executionContext,conversationJid}'))
        where owned_job.id = ${jobId}
          and app_session.app_id = ${ownerAppId}
      )`
    : undefined;
}

// prettier-ignore
function canonicalJobSessionJoinClause() { return sql`((${canonicalJobSessionId()} is not null and ${pgSchema.controlHttpSessionsPostgres.sessionId} = ${canonicalJobSessionId()}) or (${canonicalJobSessionId()} is null and ${pgSchema.controlHttpSessionsPostgres.externalRefJson}->>'chatJid' = ${canonicalJobConversationJid()}))`; }

// prettier-ignore
function canonicalJobSessionId() { return sql`${pgSchema.canonicalJobsPostgres.targetJson} #>> '{executionContext,sessionId}'`; }
// prettier-ignore
function canonicalJobConversationJid() { return sql`${pgSchema.canonicalJobsPostgres.targetJson} #>> '{executionContext,conversationJid}'`; }
// prettier-ignore
function canonicalJobGroupScope() { return sql`${pgSchema.canonicalJobsPostgres.targetJson} #>> '{executionContext,groupScope}'`; }
// prettier-ignore
function canonicalJobThreadId() { return sql`${pgSchema.canonicalJobsPostgres.targetJson} #>> '{executionContext,threadId}'`; }

function canonicalJobThreadIdNormalized() {
  return sql`coalesce(${canonicalJobThreadId()}, '')`;
}

function canonicalJobNotificationRoutes() {
  return sql`coalesce(${pgSchema.canonicalJobsPostgres.targetJson} -> 'notificationRoutes', '[]'::jsonb)`;
}

function jobRecordFromRow(
  row: typeof pgSchema.canonicalJobsPostgres.$inferSelect,
): CanonicalJobRecord {
  return {
    ...row,
    scheduleJson: jsonText(row.scheduleJson),
    targetJson: jsonText(row.targetJson),
  };
}

export class PostgresCanonicalJobRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async findJobById(id: string): Promise<CanonicalJobRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, id))
      .limit(1);
    return rows[0] ? jobRecordFromRow(rows[0]) : undefined;
  }

  async listJobs(filters?: JobListFilters): Promise<CanonicalJobRecord[]> {
    const query = this.db
      .select()
      .from(pgSchema.canonicalJobsPostgres)
      .$dynamic();
    const clauses = [
      filters?.appId
        ? sql`exists (
            select 1
            from ${pgSchema.controlHttpSessionsPostgres} app_session
            where (
              (${canonicalJobSessionId()} is not null and app_session.session_id = ${canonicalJobSessionId()})
              or (${canonicalJobSessionId()} is null and app_session.external_ref_json->>'chatJid' = ${canonicalJobConversationJid()})
            )
              and app_session.app_id = ${filters.appId}
          )`
        : undefined,
      filters?.statuses?.length
        ? inArray(pgSchema.canonicalJobsPostgres.status, filters.statuses)
        : undefined,
      filters?.groupScope
        ? sql`${canonicalJobGroupScope()} = ${filters.groupScope}`
        : undefined,
      filters?.threadId !== undefined
        ? filters.threadId
          ? sql`${canonicalJobThreadIdNormalized()} = ${filters.threadId}`
          : sql`${canonicalJobThreadIdNormalized()} = ''`
        : undefined,
      filters?.agentId
        ? sql`(
            ${pgSchema.canonicalJobsPostgres.agentId} = ${canonicalAgentId(filters.agentId)}
            or ${canonicalJobGroupScope()} = ${filters.agentId}
            or ${canonicalJobGroupScope()} = ${canonicalAgentId(filters.agentId)}
          )`
        : undefined,
      filters?.kind
        ? kindClause(filters.kind, pgSchema.canonicalJobsPostgres.scheduleJson)
        : undefined,
      filters?.conversationJid
        ? sql`${canonicalJobNotificationRoutes()} @> ${JSON.stringify([{ conversationJid: filters.conversationJid }])}::jsonb`
        : undefined,
    ].filter(Boolean);
    const filtered = clauses.length > 0 ? query.where(and(...clauses)) : query;
    const ordered = filtered.orderBy(
      desc(pgSchema.canonicalJobsPostgres.updatedAt),
      desc(pgSchema.canonicalJobsPostgres.createdAt),
    );
    const rows = filters?.limit
      ? await ordered.limit(filters.limit)
      : await ordered;
    return rows.map(jobRecordFromRow);
  }

  async upsertJob(record: JobRecordInput): Promise<void> {
    await this.ensureAgentForRecord(record);
    await this.db
      .insert(pgSchema.canonicalJobsPostgres)
      .values({
        appId: CANONICAL_APP_ID,
        createdByActorId: 'runtime',
        createdBySource: 'runtime',
        ...record,
        scheduleJson: jsonb(record.scheduleJson),
        targetJson: jsonb(record.targetJson),
      })
      .onConflictDoUpdate({
        target: pgSchema.canonicalJobsPostgres.id,
        set: {
          agentId: record.agentId,
          name: record.name,
          prompt: record.prompt,
          model: record.model,
          scheduleJson: jsonb(record.scheduleJson),
          status: record.status,
          targetJson: jsonb(record.targetJson),
          silent: record.silent,
          timeoutMs: record.timeoutMs,
          maxRetries: record.maxRetries,
          retryBackoffMs: record.retryBackoffMs,
          nextRunAt: record.nextRunAt,
          lastRunAt: record.lastRunAt,
          leaseRunId: record.leaseRunId,
          leaseExpiresAt: record.leaseExpiresAt,
          updatedAt: record.updatedAt,
        },
      });
  }

  async updateJob(
    id: string,
    record: Omit<JobRecordInput, 'id' | 'createdAt'>,
  ): Promise<void> {
    await this.ensureAgentForRecord(record);
    await this.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({
        ...record,
        scheduleJson: jsonb(record.scheduleJson),
        targetJson: jsonb(record.targetJson),
        createdByActorId: 'runtime',
        createdBySource: 'runtime',
      })
      .where(eq(pgSchema.canonicalJobsPostgres.id, id));
  }

  async deleteJob(id: string): Promise<void> {
    await this.db
      .delete(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, id));
  }

  async claimDueRunStart(input: {
    jobId: string;
    run: JobRun;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pgSchema.canonicalJobsPostgres)
        .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
        .for('update')
        .limit(1);
      const job = rows[0];
      if (
        !job ||
        job.status !== 'active' ||
        (input.requireNextRun !== false &&
          job.nextRunAt !== input.run.scheduled_for)
      ) {
        return false;
      }
      const inserted = await this.insertRun(input.run, tx);
      if (!inserted) return false;
      await tx
        .update(pgSchema.canonicalJobsPostgres)
        .set({
          status: 'running',
          leaseRunId: input.run.run_id,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.run.started_at,
        })
        .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId));
      return true;
    });
  }

  async releaseStaleLeases(
    nowIso: string = currentIso(),
  ): Promise<ReleasedStaleJobLease[]> {
    return releaseStaleCanonicalJobLeases(this.db, nowIso);
  }

  async releaseInterruptedLeases(
    nowIso: string = currentIso(),
  ): Promise<ReleasedStaleJobLease[]> {
    return releaseInterruptedCanonicalJobLeases(this.db, nowIso);
  }

  async insertRun(
    run: JobRun,
    executor:
      | CanonicalDb
      | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0] = this.db,
  ): Promise<boolean> {
    const graph = await this.ensureJobRunGraph(run.job_id, executor);
    return insertCanonicalJobRun({
      run,
      executor,
      graph,
      nextRunShortId: (jobId) => this.nextRunShortId(jobId, executor),
    });
  }

  async updateRunCompletion(
    runId: string,
    input: {
      status: JobRun['status'];
      endedAt: string;
      resultSummary: string | null;
      errorSummary: string | null;
    },
  ): Promise<void> {
    await this.db
      .update(pgSchema.agentRunsPostgres)
      .set({
        status: input.status,
        endedAt: input.endedAt,
        resultSummary: input.resultSummary,
        errorSummary: input.errorSummary,
      })
      .where(eq(pgSchema.agentRunsPostgres.id, runId));
  }

  async markRunNotified(runId: string, notifiedAt: string): Promise<void> {
    await this.db
      .update(pgSchema.agentRunsPostgres)
      .set({ notifiedAt })
      .where(eq(pgSchema.agentRunsPostgres.id, runId));
  }

  async findRunById(runId: string): Promise<CanonicalRunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentRunsPostgres)
      .where(eq(pgSchema.agentRunsPostgres.id, runId))
      .limit(1);
    return rows[0];
  }

  async listRuns(
    jobId?: string,
    limit = 50,
    filters?: JobRunListFilters,
  ): Promise<CanonicalRunRecord[]> {
    if (!jobId && filters?.jobIds?.length === 0) return [];
    if (!jobId && filters?.ownerAppId) {
      return this.listRunsForOwnerApp(filters.ownerAppId, limit, filters);
    }
    const query = this.db.select().from(pgSchema.agentRunsPostgres).$dynamic();
    const clauses = [
      jobId ? eq(pgSchema.agentRunsPostgres.jobId, jobId) : undefined,
      isNull(pgSchema.agentRunsPostgres.sessionId),
      !jobId && filters?.jobIds?.length
        ? inArray(pgSchema.agentRunsPostgres.jobId, filters.jobIds)
        : undefined,
      !jobId
        ? ownedByAppClause(
            pgSchema.agentRunsPostgres.jobId,
            filters?.ownerAppId,
          )
        : undefined,
    ].filter(Boolean);
    const filtered = clauses.length > 0 ? query.where(and(...clauses)) : query;
    return filtered
      .orderBy(
        sql`${pgSchema.agentRunsPostgres.startedAt} DESC NULLS LAST`,
        desc(pgSchema.agentRunsPostgres.createdAt),
      )
      .limit(limit);
  }

  private async listRunsForOwnerApp(
    ownerAppId: string,
    limit: number,
    filters?: JobRunListFilters,
  ): Promise<CanonicalRunRecord[]> {
    const clauses = [
      eq(pgSchema.controlHttpSessionsPostgres.appId, ownerAppId),
      isNull(pgSchema.agentRunsPostgres.sessionId),
      filters?.jobIds?.length
        ? inArray(pgSchema.agentRunsPostgres.jobId, filters.jobIds)
        : undefined,
    ].filter(Boolean);
    return this.db
      .select({
        id: pgSchema.agentRunsPostgres.id,
        shortId: pgSchema.agentRunsPostgres.shortId,
        jobId: pgSchema.agentRunsPostgres.jobId,
        status: pgSchema.agentRunsPostgres.status,
        createdAt: pgSchema.agentRunsPostgres.createdAt,
        startedAt: pgSchema.agentRunsPostgres.startedAt,
        endedAt: pgSchema.agentRunsPostgres.endedAt,
        resultSummary: pgSchema.agentRunsPostgres.resultSummary,
        errorSummary: pgSchema.agentRunsPostgres.errorSummary,
        notifiedAt: pgSchema.agentRunsPostgres.notifiedAt,
      })
      .from(pgSchema.controlHttpSessionsPostgres)
      .innerJoin(
        pgSchema.canonicalJobsPostgres,
        canonicalJobSessionJoinClause(),
      )
      .innerJoin(
        pgSchema.agentRunsPostgres,
        eq(pgSchema.agentRunsPostgres.jobId, pgSchema.canonicalJobsPostgres.id),
      )
      .where(and(...clauses))
      .orderBy(
        sql`${pgSchema.agentRunsPostgres.startedAt} DESC NULLS LAST`,
        desc(pgSchema.agentRunsPostgres.createdAt),
      )
      .limit(limit);
  }

  async listDeadLetterRuns(limit = 50): Promise<CanonicalRunRecord[]> {
    return this.db
      .select()
      .from(pgSchema.agentRunsPostgres)
      .where(
        and(
          eq(pgSchema.agentRunsPostgres.status, 'dead_lettered'),
          isNull(pgSchema.agentRunsPostgres.sessionId),
        ),
      )
      .orderBy(
        sql`${pgSchema.agentRunsPostgres.startedAt} DESC NULLS LAST`,
        desc(pgSchema.agentRunsPostgres.createdAt),
      )
      .limit(limit);
  }

  async findRuntimeEventAppIdForRun(
    runId: string,
  ): Promise<string | undefined> {
    const rows = await this.db
      .select({ appId: pgSchema.runtimeEventsPostgres.appId })
      .from(pgSchema.runtimeEventsPostgres)
      .where(eq(pgSchema.runtimeEventsPostgres.runId, runId))
      .orderBy(desc(pgSchema.runtimeEventsPostgres.eventId))
      .limit(1);
    return rows[0]?.appId;
  }

  async listEvents(
    limit = 200,
    filters?: {
      appId?: string;
      jobId?: string;
      jobIds?: string[];
      ownerAppId?: string;
      runId?: string;
      eventType?: RuntimeEventType;
      sinceId?: number;
      since?: string;
    },
  ): Promise<CanonicalJobEventRecord[]> {
    if (!filters?.jobId && filters?.jobIds?.length === 0) return [];
    if (!filters?.jobId && filters?.ownerAppId) {
      return this.listEventsForOwnerApp(limit, filters);
    }
    const query = this.db
      .select()
      .from(pgSchema.runtimeEventsPostgres)
      .$dynamic();
    const clauses = [
      filters?.appId
        ? eq(pgSchema.runtimeEventsPostgres.appId, filters.appId)
        : !filters?.jobId && !filters?.jobIds?.length && !filters?.ownerAppId
          ? eq(pgSchema.runtimeEventsPostgres.appId, CANONICAL_APP_ID)
          : undefined,
      filters?.runId
        ? eq(pgSchema.runtimeEventsPostgres.runId, filters.runId)
        : undefined,
      filters?.jobId
        ? eq(pgSchema.runtimeEventsPostgres.jobId, filters.jobId)
        : undefined,
      !filters?.jobId && filters?.jobIds?.length
        ? inArray(pgSchema.runtimeEventsPostgres.jobId, filters.jobIds)
        : undefined,
      !filters?.jobId
        ? ownedByAppClause(
            pgSchema.runtimeEventsPostgres.jobId,
            filters?.ownerAppId,
          )
        : undefined,
      filters?.eventType
        ? eq(pgSchema.runtimeEventsPostgres.eventType, filters.eventType)
        : inArray(
            pgSchema.runtimeEventsPostgres.eventType,
            CANONICAL_JOB_EVENT_TYPES,
          ),
      filters?.sinceId !== undefined
        ? gt(pgSchema.runtimeEventsPostgres.eventId, filters.sinceId)
        : undefined,
      filters?.since
        ? gt(pgSchema.runtimeEventsPostgres.createdAt, filters.since)
        : undefined,
    ].filter(Boolean);
    const filtered = clauses.length > 0 ? query.where(and(...clauses)) : query;
    const rows = await filtered
      .orderBy(desc(pgSchema.runtimeEventsPostgres.eventId))
      .limit(limit);
    return rows.map((row) => ({
      id: String(row.eventId),
      appId: row.appId,
      runId: row.runId ?? '',
      jobId: row.jobId ?? '',
      type: row.eventType,
      payloadJson: row.payloadJson,
      createdAt: row.createdAt,
    }));
  }

  private async listEventsForOwnerApp(
    limit: number,
    filters: NonNullable<
      Parameters<PostgresCanonicalJobRepository['listEvents']>[1]
    >,
  ): Promise<CanonicalJobEventRecord[]> {
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
    const rows = await this.db
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
      .innerJoin(
        pgSchema.canonicalJobsPostgres,
        canonicalJobSessionJoinClause(),
      )
      .innerJoin(
        pgSchema.runtimeEventsPostgres,
        eq(
          pgSchema.runtimeEventsPostgres.jobId,
          pgSchema.canonicalJobsPostgres.id,
        ),
      )
      .where(and(...clauses))
      .orderBy(desc(pgSchema.runtimeEventsPostgres.eventId))
      .limit(limit);
    return rows.map((row) => ({
      id: String(row.eventId),
      appId: row.appId,
      runId: row.runId ?? '',
      jobId: row.jobId ?? '',
      type: row.eventType,
      payloadJson: row.payloadJson,
      createdAt: row.createdAt,
    }));
  }

  private async ensureJobRunGraph(
    jobId: string,
    executor:
      | CanonicalDb
      | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0],
  ): Promise<{ agentId: string; configVersionId: string }> {
    const rows = await executor
      .select()
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, jobId))
      .limit(1);
    const row = rows[0];
    const target = row
      ? parseJson<Record<string, unknown>>(row.targetJson, {})
      : {};
    const executionContext =
      target.executionContext &&
      typeof target.executionContext === 'object' &&
      !Array.isArray(target.executionContext)
        ? (target.executionContext as Record<string, unknown>)
        : undefined;
    const folder = row
      ? ((executionContext?.groupScope as string | undefined) ??
        row.agentId?.replace(/^agent:/, '') ??
        'system')
      : 'system';
    const agentId = await this.graph.ensureAgentExists(
      folder,
      folder,
      executor,
    );
    return { agentId, configVersionId: configVersionIdForAgent(agentId) };
  }
  private async nextRunShortId(
    jobId: string,
    executor:
      | CanonicalDb
      | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0],
  ): Promise<number> {
    const rows = await executor
      .select({
        nextShortId: sql<number>`coalesce(max(${pgSchema.agentRunsPostgres.shortId}), 0) + 1`,
      })
      .from(pgSchema.agentRunsPostgres)
      .where(eq(pgSchema.agentRunsPostgres.jobId, jobId))
      .limit(1);
    return Number(rows[0]?.nextShortId ?? 1);
  }

  private async ensureAgentForRecord(input: {
    agentId: string;
    name?: string;
  }): Promise<void> {
    const folder = input.agentId.replace(/^agent:/, '');
    await this.graph.ensureAgentExists(folder, folder);
  }
}
