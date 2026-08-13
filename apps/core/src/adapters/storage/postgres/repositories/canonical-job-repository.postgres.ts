import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  listEventsForOwnerApp,
  listFirstEventPerRun,
} from './canonical-job-events-first-per-run.postgres.js';
// prettier-ignore
const eventIdOrder = (order?: 'asc' | 'desc') => (order === 'asc' ? asc(pgSchema.runtimeEventsPostgres.eventId) : desc(pgSchema.runtimeEventsPostgres.eventId));

import type {
  Job,
  JobRun,
} from '../../../../domain/repositories/domain-types.js';
// prettier-ignore
import type { JobAccessRequirementAppend, JobListFilters, JobRunListFilters, ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import type { RuntimeEventType } from '../../../../domain/events/runtime-event-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  type CanonicalJobCoordinationUpdate,
  coordinationColumnUpdate,
  markJobSetupNotified as markJobSetupNotifiedStatement,
  refreshSetupPausedJob as refreshSetupPausedJobStatement,
  resumeSetupPausedJob as resumeSetupPausedJobStatement,
} from './canonical-job-coordination.postgres.js';
export * from './canonical-job-records.js';
import type {
  CanonicalJobEventRecord,
  CanonicalJobRecord,
  CanonicalJobTerminalUpdate,
  CanonicalRunRecord,
  JobRecordInput,
} from './canonical-job-records.js';
// prettier-ignore
import { CANONICAL_APP_ID, type CanonicalDb, PostgresCanonicalGraphRepository, configVersionIdForAgent, jsonb, jsonText, parseJson } from './canonical-graph-repository.postgres.js';
import { CANONICAL_JOB_EVENT_TYPES } from './canonical-job-event-types.postgres.js';
import { releaseStaleCanonicalJobLeases } from './canonical-job-lease-release.postgres.js';
import { insertCanonicalJobRun } from './canonical-job-run-insert.postgres.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import { claimDueCanonicalJobRunStart } from './canonical-job-claim.postgres.js';
import { settleRunLeaseTx } from './worker-coordination-lease.postgres.js';
import { updateCanonicalJobRunProviderMetadata } from './canonical-job-run-provider-metadata.postgres.js';
import {
  activeRunLeaseFence,
  settledRunLeaseFence,
  type RunLeaseFence,
} from './run-lease-fence.postgres.js';
import { appendCanonicalJobAccessRequirement } from './canonical-job-access-requirements.postgres.js';

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
function canonicalJobWorkspaceKey() { return sql`${pgSchema.canonicalJobsPostgres.targetJson} #>> '{executionContext,workspaceKey}'`; }
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

const canonicalRunProjection = {
  id: pgSchema.agentRunsPostgres.id,
  shortId: pgSchema.agentRunsPostgres.shortId,
  jobId: pgSchema.agentRunsPostgres.jobId,
  executionProviderId: pgSchema.agentRunsPostgres.executionProviderId,
  providerRunId: pgSchema.agentRunsPostgres.providerRunId,
  providerSessionId: pgSchema.agentRunsPostgres.providerSessionId,
  workerId: pgSchema.agentRunsPostgres.workerId,
  leaseOwner: pgSchema.agentRunsPostgres.leaseOwner,
  leaseExpiresAt: pgSchema.agentRunsPostgres.leaseExpiresAt,
  status: pgSchema.agentRunsPostgres.status,
  createdAt: pgSchema.agentRunsPostgres.createdAt,
  startedAt: pgSchema.agentRunsPostgres.startedAt,
  endedAt: pgSchema.agentRunsPostgres.endedAt,
  resultSummary: pgSchema.agentRunsPostgres.resultSummary,
  errorSummary: pgSchema.agentRunsPostgres.errorSummary,
  notifiedAt: pgSchema.agentRunsPostgres.notifiedAt,
} satisfies Record<keyof CanonicalRunRecord, unknown>;

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
      filters?.workspaceKey
        ? sql`${canonicalJobWorkspaceKey()} = ${filters.workspaceKey}`
        : undefined,
      filters?.threadId !== undefined
        ? filters.threadId
          ? sql`${canonicalJobThreadIdNormalized()} = ${filters.threadId}`
          : sql`${canonicalJobThreadIdNormalized()} = ''`
        : undefined,
      filters?.agentId
        ? sql`(
            ${pgSchema.canonicalJobsPostgres.agentId} = ${canonicalAgentId(filters.agentId)}
            or ${canonicalJobWorkspaceKey()} = ${filters.agentId}
            or ${canonicalJobWorkspaceKey()} = ${canonicalAgentId(filters.agentId)}
          )`
        : undefined,
      filters?.kind
        ? kindClause(filters.kind, pgSchema.canonicalJobsPostgres.scheduleJson)
        : undefined,
      filters?.conversationJid
        ? sql`${canonicalJobNotificationRoutes()} @> ${JSON.stringify([{ conversationJid: filters.conversationJid }])}::jsonb`
        : undefined,
      filters?.pageAfter
        ? sql`(
            ${pgSchema.canonicalJobsPostgres.createdAt} < ${filters.pageAfter.createdAt}
            or (${pgSchema.canonicalJobsPostgres.createdAt} = ${filters.pageAfter.createdAt}
              and ${pgSchema.canonicalJobsPostgres.id} < ${filters.pageAfter.id})
          )`
        : undefined,
    ].filter(Boolean);
    const filtered = clauses.length > 0 ? query.where(and(...clauses)) : query;
    const ordered =
      filters?.orderBy === 'created_at'
        ? filtered.orderBy(
            desc(pgSchema.canonicalJobsPostgres.createdAt),
            desc(pgSchema.canonicalJobsPostgres.id),
          )
        : filtered.orderBy(
            desc(pgSchema.canonicalJobsPostgres.updatedAt),
            desc(pgSchema.canonicalJobsPostgres.createdAt),
            desc(pgSchema.canonicalJobsPostgres.id),
          );
    const rows = filters?.limit
      ? await ordered.limit(filters.limit)
      : await ordered;
    return rows.map(jobRecordFromRow);
  }

  async upsertJob(
    record: JobRecordInput,
    coordination: Required<
      Omit<CanonicalJobCoordinationUpdate, 'incrementConsecutiveFailures'>
    >,
  ): Promise<void> {
    await this.ensureAgentForRecord(record);
    await this.db
      .insert(pgSchema.canonicalJobsPostgres)
      .values({
        appId: CANONICAL_APP_ID,
        createdByActorId: 'runtime',
        createdBySource: 'runtime',
        ...record,
        ...coordination,
        scheduleJson: jsonb(record.scheduleJson),
        targetJson: jsonb(record.targetJson),
        setupState: jsonb(coordination.setupState),
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
          consecutiveFailures: coordination.consecutiveFailures,
          maxConsecutiveFailures: coordination.maxConsecutiveFailures,
          pauseReason: coordination.pauseReason,
          setupState: jsonb(coordination.setupState),
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
    coordination: CanonicalJobCoordinationUpdate,
  ): Promise<void> {
    await this.ensureAgentForRecord(record);
    await this.db
      .update(pgSchema.canonicalJobsPostgres)
      .set({
        ...record,
        scheduleJson: jsonb(record.scheduleJson),
        targetJson: jsonb(record.targetJson),
        ...coordinationColumnUpdate(coordination),
        createdByActorId: 'runtime',
        createdBySource: 'runtime',
      })
      .where(eq(pgSchema.canonicalJobsPostgres.id, id));
  }

  async appendJobAccessRequirement(
    input: JobAccessRequirementAppend,
  ): Promise<boolean> {
    return appendCanonicalJobAccessRequirement(this.db, input);
  }

  async markJobSetupNotified(
    id: string,
    expectedFingerprint: string,
  ): Promise<boolean> {
    return markJobSetupNotifiedStatement(this.db, id, expectedFingerprint);
  }

  async resumeSetupPausedJob(input: {
    jobId: string;
    expectedSetupCheckedAt: string;
    expectedPauseReason: string;
    nextRun: string;
    setupState: NonNullable<Job['setup_state']>;
  }): Promise<boolean> {
    return resumeSetupPausedJobStatement(this.db, input);
  }

  async refreshSetupPausedJob(input: {
    jobId: string;
    expectedSetupCheckedAt: string;
    expectedPauseReason: string;
    setupState: NonNullable<Job['setup_state']>;
  }): Promise<boolean> {
    return refreshSetupPausedJobStatement(this.db, input);
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
    workerInstanceId: string;
    requireNextRun?: boolean;
  }): Promise<RunLease | null> {
    return claimDueCanonicalJobRunStart({
      db: this.db,
      ...input,
      insertRun: (run, tx) => this.insertRun(run, tx),
    });
  }

  async settleRunLease(input: {
    runId: string;
    leaseToken: string;
    outcome: 'completed' | 'failed' | 'released';
    allowAlreadySettled?: boolean;
  }): Promise<boolean> {
    return settleRunLeaseTx(this.db, input);
  }

  async releaseStaleLeases(
    nowIso: string = currentIso(),
  ): Promise<ReleasedStaleJobLease[]> {
    return releaseStaleCanonicalJobLeases(this.db, nowIso);
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

  async updateRunCompletionWithLease(
    runId: string,
    input: {
      leaseToken: string;
      workerInstanceId: string;
      fencingVersion: number;
      status: JobRun['status'];
      endedAt: string;
      resultSummary: string | null;
      errorSummary: string | null;
    },
  ): Promise<boolean> {
    const now = currentIso();
    const rows = await this.db
      .update(pgSchema.agentRunsPostgres)
      .set({
        status: input.status,
        endedAt: input.endedAt,
        resultSummary: input.resultSummary,
        errorSummary: input.errorSummary,
      })
      .where(
        and(
          eq(pgSchema.agentRunsPostgres.id, runId),
          activeRunLeaseFence({
            runId,
            fence: input,
            now,
          }),
        ),
      )
      .returning({ id: pgSchema.agentRunsPostgres.id });
    return rows.length > 0;
  }

  async finalizeRunCompletionWithLease(input: {
    runId: string;
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
    leaseOutcome: 'completed' | 'failed' | 'released';
    runCompletion: {
      status: JobRun['status'];
      endedAt: string;
      resultSummary: string | null;
      errorSummary: string | null;
    };
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const now = currentIso();
      const runs = pgSchema.agentRunsPostgres;
      const runRows = await tx
        .update(runs)
        .set({
          status: input.runCompletion.status,
          endedAt: input.runCompletion.endedAt,
          resultSummary: input.runCompletion.resultSummary,
          errorSummary: input.runCompletion.errorSummary,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            activeRunLeaseFence({
              runId: input.runId,
              fence: input,
              now,
            }),
          ),
        )
        .returning({ id: runs.id });
      if (runRows.length === 0) return false;

      const settled = await settleRunLeaseTx(tx, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        workerInstanceId: input.workerInstanceId,
        fencingVersion: input.fencingVersion,
        outcome: input.leaseOutcome,
      });
      if (!settled) {
        throw new Error('Run lease was lost during terminal finalization.');
      }
      return true;
    });
  }

  async finalizeRunWithLease(input: {
    jobId: string;
    runId: string;
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
    leaseOutcome: 'completed' | 'failed' | 'released';
    runCompletion: {
      status: JobRun['status'];
      endedAt: string;
      resultSummary: string | null;
      errorSummary: string | null;
    };
    jobUpdate: CanonicalJobTerminalUpdate;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const now = currentIso();
      const runs = pgSchema.agentRunsPostgres;
      const runRows = await tx
        .update(runs)
        .set({
          status: input.runCompletion.status,
          endedAt: input.runCompletion.endedAt,
          resultSummary: input.runCompletion.resultSummary,
          errorSummary: input.runCompletion.errorSummary,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            activeRunLeaseFence({
              runId: input.runId,
              fence: input,
              now,
            }),
          ),
        )
        .returning({ id: runs.id });
      if (runRows.length === 0) return false;

      const jobRows = await tx
        .update(pgSchema.canonicalJobsPostgres)
        .set({
          ...(input.jobUpdate.status !== undefined
            ? { status: input.jobUpdate.status }
            : {}),
          ...(input.jobUpdate.nextRunAt !== undefined
            ? { nextRunAt: input.jobUpdate.nextRunAt }
            : {}),
          ...(input.jobUpdate.lastRunAt !== undefined
            ? { lastRunAt: input.jobUpdate.lastRunAt }
            : {}),
          ...(input.jobUpdate.leaseRunId !== undefined
            ? { leaseRunId: input.jobUpdate.leaseRunId }
            : {}),
          ...(input.jobUpdate.leaseExpiresAt !== undefined
            ? { leaseExpiresAt: input.jobUpdate.leaseExpiresAt }
            : {}),
          ...coordinationColumnUpdate(input.jobUpdate.coordination),
          updatedAt: input.jobUpdate.updatedAt,
        })
        .where(
          and(
            eq(pgSchema.canonicalJobsPostgres.id, input.jobId),
            eq(pgSchema.canonicalJobsPostgres.leaseRunId, input.runId),
          ),
        )
        .returning({ id: pgSchema.canonicalJobsPostgres.id });
      if (jobRows.length === 0) {
        throw new Error('Job lease row was lost during terminal finalization.');
      }

      const settled = await settleRunLeaseTx(tx, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        workerInstanceId: input.workerInstanceId,
        fencingVersion: input.fencingVersion,
        outcome: input.leaseOutcome,
      });
      if (!settled) {
        throw new Error('Run lease was lost during terminal finalization.');
      }
      return true;
    });
  }

  // prettier-ignore
  async updateRunProviderMetadata(runId: string | readonly string[], input: { fenceRunId?: string; leaseToken?: string; workerInstanceId?: string; fencingVersion?: number; providerRunId?: string | null; providerSessionId?: string | null }): Promise<boolean> {
    return updateCanonicalJobRunProviderMetadata(this.db, runId, input);
  }

  async markRunNotified(
    runId: string,
    notifiedAt: string,
    lease?: RunLeaseFence,
  ): Promise<boolean> {
    const now = currentIso();
    const leaseFence = lease
      ? settledRunLeaseFence({ runId, fence: lease, now })
      : undefined;
    const rows = await this.db
      .update(pgSchema.agentRunsPostgres)
      .set({ notifiedAt })
      .where(
        leaseFence
          ? and(eq(pgSchema.agentRunsPostgres.id, runId), leaseFence)
          : eq(pgSchema.agentRunsPostgres.id, runId),
      )
      .returning({ id: pgSchema.agentRunsPostgres.id });
    return rows.length > 0;
  }

  async findRunById(runId: string): Promise<CanonicalRunRecord | undefined> {
    const rows = await this.db
      .select(canonicalRunProjection)
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
    const query = this.db
      .select(canonicalRunProjection)
      .from(pgSchema.agentRunsPostgres)
      .$dynamic();
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

  async listLatestJobRunsByJobIds(
    jobIds: readonly string[],
  ): Promise<CanonicalRunRecord[]> {
    if (jobIds.length === 0) return [];
    return this.db
      .selectDistinctOn(
        [pgSchema.agentRunsPostgres.jobId],
        canonicalRunProjection,
      )
      .from(pgSchema.agentRunsPostgres)
      .where(
        and(
          inArray(pgSchema.agentRunsPostgres.jobId, jobIds),
          isNull(pgSchema.agentRunsPostgres.sessionId),
        ),
      )
      .orderBy(
        pgSchema.agentRunsPostgres.jobId,
        sql`${pgSchema.agentRunsPostgres.startedAt} DESC NULLS LAST`,
        desc(pgSchema.agentRunsPostgres.createdAt),
      );
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
    const rows = await this.db
      .select(canonicalRunProjection)
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
    return rows;
  }

  async listDeadLetterRuns(limit = 50): Promise<CanonicalRunRecord[]> {
    return this.db
      .select(canonicalRunProjection)
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
      // prettier-ignore
      runIds?: string[];
      firstPerRun?: boolean;
      order?: 'asc' | 'desc';
      eventType?: RuntimeEventType;
      sinceId?: number;
      since?: string;
    },
  ): Promise<CanonicalJobEventRecord[]> {
    if (!filters?.jobId && filters?.jobIds?.length === 0) return [];
    if (!filters?.jobId && filters?.ownerAppId) {
      // prettier-ignore
      return listEventsForOwnerApp(this.db, limit, filters, canonicalJobSessionJoinClause(), eventIdOrder(filters?.order));
    }
    if (filters?.runIds && filters.firstPerRun) {
      // prettier-ignore
      return filters.runIds.length === 0 ? [] : listFirstEventPerRun(this.db, limit, { runIds: filters.runIds, eventType: filters.eventType, appId: filters.appId });
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
      .orderBy(eventIdOrder(filters?.order))
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
      ? ((executionContext?.workspaceKey as string | undefined) ??
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
