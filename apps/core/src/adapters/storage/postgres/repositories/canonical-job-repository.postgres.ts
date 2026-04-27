import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';

import type { JobRun } from '../../../../domain/repositories/domain-types.js';
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
  modelOverride: string | null;
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
  modelOverride: string | null;
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
  runId: string;
  type: string;
  payloadJson: string;
  createdAt: string;
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

  async listJobs(): Promise<CanonicalJobRecord[]> {
    return this.db
      .select()
      .from(pgSchema.canonicalJobsPostgres)
      .orderBy(
        desc(pgSchema.canonicalJobsPostgres.updatedAt),
        desc(pgSchema.canonicalJobsPostgres.createdAt),
      );
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
          modelOverride: record.modelOverride,
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

  async listRuns(jobId?: string, limit = 50): Promise<CanonicalRunRecord[]> {
    const query = this.db.select().from(pgSchema.agentRunsPostgres).$dynamic();
    const filtered = jobId
      ? query.where(eq(pgSchema.agentRunsPostgres.jobId, jobId))
      : query;
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

  async insertEvent(event: {
    id: string;
    runId: string;
    type: string;
    payloadJson: string;
    createdAt: string;
  }): Promise<void> {
    await this.db.insert(pgSchema.agentRunEventsPostgres).values({
      id: event.id,
      appId: CANONICAL_APP_ID,
      runId: event.runId,
      type: event.type,
      payloadJson: event.payloadJson,
      createdAt: event.createdAt,
    });
  }

  async listEvents(
    limit = 200,
    filters?: { runId?: string; eventType?: string },
  ): Promise<CanonicalJobEventRecord[]> {
    const query = this.db
      .select()
      .from(pgSchema.agentRunEventsPostgres)
      .$dynamic();
    const clauses = [
      filters?.runId
        ? eq(pgSchema.agentRunEventsPostgres.runId, filters.runId)
        : undefined,
      filters?.eventType
        ? eq(pgSchema.agentRunEventsPostgres.type, filters.eventType)
        : undefined,
    ].filter(Boolean);
    const filtered = clauses.length > 0 ? query.where(and(...clauses)) : query;
    return filtered
      .orderBy(
        desc(pgSchema.agentRunEventsPostgres.createdAt),
        desc(pgSchema.agentRunEventsPostgres.id),
      )
      .limit(limit);
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
