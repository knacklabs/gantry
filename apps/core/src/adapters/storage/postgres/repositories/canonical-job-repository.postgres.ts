import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { JobRun } from '../../../../domain/repositories/domain-types.js';
import type {
  JobListFilters,
  JobRunListFilters,
} from '../../../../domain/repositories/ops-repo.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  DEFAULT_LLM_PROFILE_ID,
  PostgresCanonicalGraphRepository,
  configVersionIdForAgent,
  parseJson,
} from './canonical-graph-repository.postgres.js';

export interface CanonicalJobRecord {
  id: string;
  agentId: string | null;
  name: string;
  prompt: string;
  model: string | null;
  scheduleJson: string;
  status: string;
  executionMode: string;
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
  executionMode: string;
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
  jobId: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  resultSummary: string | null;
  errorSummary: string | null;
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
  RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
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
    return sql`${scheduleJson}::jsonb ->> 'type' = 'manual'`;
  }
  if (kind === 'once') {
    return sql`${scheduleJson}::jsonb ->> 'type' = 'once'`;
  }
  return sql`${scheduleJson}::jsonb ->> 'type' in ('cron', 'interval')`;
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
    return rows[0];
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
            from jsonb_array_elements_text(coalesce(${pgSchema.canonicalJobsPostgres.targetJson}::jsonb -> 'linkedSessions', '[]'::jsonb)) as linked_session(value)
            where linked_session.value like ${`app:${filters.appId}:%`}
          )`
        : undefined,
      filters?.statuses?.length
        ? inArray(pgSchema.canonicalJobsPostgres.status, filters.statuses)
        : undefined,
      filters?.groupScope
        ? sql`${pgSchema.canonicalJobsPostgres.targetJson}::jsonb ->> 'groupScope' = ${filters.groupScope}`
        : undefined,
      filters && 'threadId' in filters
        ? filters.threadId
          ? sql`${pgSchema.canonicalJobsPostgres.targetJson}::jsonb ->> 'threadId' = ${filters.threadId}`
          : sql`coalesce(${pgSchema.canonicalJobsPostgres.targetJson}::jsonb ->> 'threadId', '') = ''`
        : undefined,
      filters?.agentId
        ? sql`(
            ${pgSchema.canonicalJobsPostgres.agentId} = ${canonicalAgentId(filters.agentId)}
            or ${pgSchema.canonicalJobsPostgres.targetJson}::jsonb ->> 'groupScope' = ${filters.agentId}
            or ${pgSchema.canonicalJobsPostgres.targetJson}::jsonb ->> 'groupScope' = ${canonicalAgentId(filters.agentId)}
          )`
        : undefined,
      filters?.kind
        ? kindClause(filters.kind, pgSchema.canonicalJobsPostgres.scheduleJson)
        : undefined,
      filters?.conversationJid
        ? sql`exists (
            select 1
            from jsonb_array_elements_text(coalesce(${pgSchema.canonicalJobsPostgres.targetJson}::jsonb -> 'linkedSessions', '[]'::jsonb)) as linked_session(value)
            where linked_session.value = ${filters.conversationJid}
          )`
        : undefined,
    ].filter(Boolean);
    const filtered = clauses.length > 0 ? query.where(and(...clauses)) : query;
    const ordered = filtered.orderBy(
      desc(pgSchema.canonicalJobsPostgres.updatedAt),
      desc(pgSchema.canonicalJobsPostgres.createdAt),
    );
    return filters?.limit ? ordered.limit(filters.limit) : ordered;
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
      })
      .onConflictDoUpdate({
        target: pgSchema.canonicalJobsPostgres.id,
        set: {
          agentId: record.agentId,
          name: record.name,
          prompt: record.prompt,
          model: record.model,
          scheduleJson: record.scheduleJson,
          status: record.status,
          executionMode: record.executionMode,
          targetJson: record.targetJson,
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

  async releaseStaleLeases(nowIso: string = currentIso()): Promise<number> {
    const rows = await this.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({
        status: 'active',
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(pgSchema.canonicalJobsPostgres.status, 'running'),
          isNotNull(pgSchema.canonicalJobsPostgres.leaseExpiresAt),
          lt(pgSchema.canonicalJobsPostgres.leaseExpiresAt, nowIso),
        ),
      )
      .returning({ id: pgSchema.canonicalJobsPostgres.id });
    return rows.length;
  }

  async insertRun(
    run: JobRun,
    executor:
      | CanonicalDb
      | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0] = this.db,
  ): Promise<boolean> {
    const graph = await this.ensureJobRunGraph(run.job_id, executor);
    const rows = await executor
      .insert(pgSchema.agentRunsPostgres)
      .values({
        id: run.run_id,
        appId: CANONICAL_APP_ID,
        agentId: graph.agentId,
        configVersionId: graph.configVersionId,
        jobId: run.job_id,
        llmProfileId: DEFAULT_LLM_PROFILE_ID,
        cause: 'job',
        status: run.status,
        createdAt: run.scheduled_for || run.started_at,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        resultSummary: run.result_summary,
        errorSummary: run.error_summary,
      })
      .onConflictDoNothing()
      .returning({ id: pgSchema.agentRunsPostgres.id });
    return rows.length > 0;
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
    const query = this.db.select().from(pgSchema.agentRunsPostgres).$dynamic();
    const clauses = [
      jobId ? eq(pgSchema.agentRunsPostgres.jobId, jobId) : undefined,
      !jobId && filters?.jobIds?.length
        ? inArray(pgSchema.agentRunsPostgres.jobId, filters.jobIds)
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

  async listDeadLetterRuns(limit = 50): Promise<CanonicalRunRecord[]> {
    return this.db
      .select()
      .from(pgSchema.agentRunsPostgres)
      .where(eq(pgSchema.agentRunsPostgres.status, 'dead_lettered'))
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

  async insertEvent(event: {
    id: string;
    runId: string;
    type: string;
    payloadJson: string;
    createdAt: string;
  }): Promise<void> {
    const payload = parseJson<{ job_id?: string }>(event.payloadJson, {});
    await this.db.insert(pgSchema.runtimeEventsPostgres).values({
      appId: CANONICAL_APP_ID,
      runId: event.runId,
      jobId: payload.job_id ?? null,
      eventType: event.type,
      actor: 'runtime',
      payloadJson: event.payloadJson,
      createdAt: event.createdAt,
    });
  }

  async listEvents(
    limit = 200,
    filters?: {
      appId?: string;
      jobId?: string;
      jobIds?: string[];
      runId?: string;
      eventType?: string;
      sinceId?: number;
      since?: string;
    },
  ): Promise<CanonicalJobEventRecord[]> {
    const query = this.db
      .select()
      .from(pgSchema.runtimeEventsPostgres)
      .$dynamic();
    const clauses = [
      eq(
        pgSchema.runtimeEventsPostgres.appId,
        filters?.appId ?? CANONICAL_APP_ID,
      ),
      filters?.runId
        ? eq(pgSchema.runtimeEventsPostgres.runId, filters.runId)
        : undefined,
      filters?.jobId
        ? eq(pgSchema.runtimeEventsPostgres.jobId, filters.jobId)
        : undefined,
      !filters?.jobId && filters?.jobIds?.length
        ? inArray(pgSchema.runtimeEventsPostgres.jobId, filters.jobIds)
        : undefined,
      filters?.eventType
        ? eq(
            pgSchema.runtimeEventsPostgres.eventType,
            filters.eventType as never,
          )
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
    const folder = row
      ? ((target.groupScope as string | undefined) ??
        row.agentId?.replace(/^agent:/, '') ??
        'system')
      : 'system';
    const agentId = await this.graph.ensureAgent(folder, folder, executor);
    return { agentId, configVersionId: configVersionIdForAgent(agentId) };
  }

  private async ensureAgentForRecord(input: {
    agentId: string;
    name?: string;
  }): Promise<void> {
    const folder = input.agentId.replace(/^agent:/, '');
    await this.graph.ensureAgent(folder, input.name || folder);
  }
}
