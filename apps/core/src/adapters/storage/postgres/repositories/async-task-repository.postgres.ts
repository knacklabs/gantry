import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from 'drizzle-orm';

import type {
  AsyncTaskBacklogAdmissionInput,
  AsyncTaskClaimInput,
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskReceipt,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskScopedAdmissionInput,
  AsyncTaskScopedAdmissionResult,
  AsyncTaskStatus,
  AsyncTaskStatusCount,
  AsyncTaskTransitionInput,
} from '../../../../domain/ports/async-tasks.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export class PostgresAsyncTaskRepository implements AsyncTaskRepository {
  constructor(private readonly db: CanonicalDb) {}

  async createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord> {
    const [row] = await this.db
      .insert(pgSchema.agentAsyncTasksPostgres)
      .values(taskInsertValues(input))
      .returning();
    return mapRow(row);
  }

  async createTaskWithBacklogAdmission(
    input: AsyncTaskBacklogAdmissionInput,
  ): Promise<AsyncTaskRecord | null> {
    return this.db.transaction(async (tx) => {
      const task = input.task;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent_async_tasks_backlog:${task.appId}:${task.kind}`}))`,
      );
      const [appBacklog] = await tx
        .select({ count: count() })
        .from(pgSchema.agentAsyncTasksPostgres)
        .where(
          and(
            eq(pgSchema.agentAsyncTasksPostgres.appId, task.appId),
            eq(pgSchema.agentAsyncTasksPostgres.kind, task.kind),
            inArray(pgSchema.agentAsyncTasksPostgres.status, input.statuses),
          ),
        );
      if ((appBacklog?.count ?? 0) >= input.maxBacklogPerApp) return null;
      const [agentBacklog] = await tx
        .select({ count: count() })
        .from(pgSchema.agentAsyncTasksPostgres)
        .where(
          and(
            eq(pgSchema.agentAsyncTasksPostgres.appId, task.appId),
            eq(pgSchema.agentAsyncTasksPostgres.agentId, task.agentId),
            eq(pgSchema.agentAsyncTasksPostgres.kind, task.kind),
            inArray(pgSchema.agentAsyncTasksPostgres.status, input.statuses),
          ),
        );
      if ((agentBacklog?.count ?? 0) >= input.maxBacklogPerAgent) return null;
      const [row] = await tx
        .insert(pgSchema.agentAsyncTasksPostgres)
        .values(taskInsertValues(task))
        .returning();
      return mapRow(row);
    });
  }

  async createTaskWithScopedAdmission(
    input: AsyncTaskScopedAdmissionInput,
  ): Promise<AsyncTaskScopedAdmissionResult> {
    return this.db.transaction(async (tx) => {
      const task = input.task;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${scopedAdmissionLockKey(task)}))`,
      );
      const scopeWhere = asyncTaskScopeWhere(task);
      const staleTasks =
        input.staleRunningBefore && input.staleRunningStatus
          ? (
              await tx
                .update(pgSchema.agentAsyncTasksPostgres)
                .set({
                  status: input.staleRunningStatus,
                  terminalAt: task.now,
                  updatedAt: task.now,
                  errorSummary: input.staleErrorSummary ?? null,
                })
                .where(
                  and(
                    scopeWhere,
                    inArray(
                      pgSchema.agentAsyncTasksPostgres.status,
                      input.activeStatuses,
                    ),
                    sql`coalesce(${pgSchema.agentAsyncTasksPostgres.heartbeatAt}, ${pgSchema.agentAsyncTasksPostgres.updatedAt}) < ${input.staleRunningBefore}`,
                  ),
                )
                .returning()
            ).map(mapRow)
          : [];
      const [existing] = await tx
        .select()
        .from(pgSchema.agentAsyncTasksPostgres)
        .where(
          and(
            scopeWhere,
            input.activeStatuses.length
              ? inArray(
                  pgSchema.agentAsyncTasksPostgres.status,
                  input.activeStatuses,
                )
              : undefined,
          ),
        )
        .orderBy(desc(pgSchema.agentAsyncTasksPostgres.updatedAt))
        .limit(1);
      if (existing) {
        return { task: mapRow(existing), admitted: false, staleTasks };
      }
      const [row] = await tx
        .insert(pgSchema.agentAsyncTasksPostgres)
        .values(taskInsertValues(task))
        .returning();
      return { task: mapRow(row), admitted: true, staleTasks };
    });
  }

  async claimQueuedTask(
    input: AsyncTaskClaimInput,
  ): Promise<AsyncTaskRecord | null> {
    return this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(pgSchema.agentAsyncTasksPostgres)
        .where(eq(pgSchema.agentAsyncTasksPostgres.id, input.taskId))
        .limit(1);
      if (!task || task.status !== 'queued') return null;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agent_async_tasks:${task.appId}:${task.kind}`}))`,
      );
      const [appRunning] = await tx
        .select({ count: count() })
        .from(pgSchema.agentAsyncTasksPostgres)
        .where(
          and(
            eq(pgSchema.agentAsyncTasksPostgres.appId, task.appId),
            eq(pgSchema.agentAsyncTasksPostgres.kind, task.kind),
            eq(pgSchema.agentAsyncTasksPostgres.status, 'running'),
          ),
        );
      if ((appRunning?.count ?? 0) >= input.maxRunningPerApp) return null;
      const [agentRunning] = await tx
        .select({ count: count() })
        .from(pgSchema.agentAsyncTasksPostgres)
        .where(
          and(
            eq(pgSchema.agentAsyncTasksPostgres.appId, task.appId),
            eq(pgSchema.agentAsyncTasksPostgres.agentId, task.agentId),
            eq(pgSchema.agentAsyncTasksPostgres.kind, task.kind),
            eq(pgSchema.agentAsyncTasksPostgres.status, 'running'),
          ),
        );
      if ((agentRunning?.count ?? 0) >= input.maxRunningPerAgent) return null;
      const [row] = await tx
        .update(pgSchema.agentAsyncTasksPostgres)
        .set({
          status: 'running',
          leaseToken: input.leaseToken,
          fencingVersion: task.fencingVersion + 1,
          startedAt: input.now,
          heartbeatAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(pgSchema.agentAsyncTasksPostgres.id, input.taskId),
            eq(pgSchema.agentAsyncTasksPostgres.status, 'queued'),
          ),
        )
        .returning();
      return row ? mapRow(row) : null;
    });
  }

  async getTask(taskId: string): Promise<AsyncTaskRecord | null> {
    const [row] = await this.db
      .select()
      .from(pgSchema.agentAsyncTasksPostgres)
      .where(eq(pgSchema.agentAsyncTasksPostgres.id, taskId))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentAsyncTasksPostgres)
      .where(asyncTaskFilterWhere(filter))
      .orderBy(
        filter.order === 'oldest_first'
          ? asc(pgSchema.agentAsyncTasksPostgres.updatedAt)
          : desc(pgSchema.agentAsyncTasksPostgres.updatedAt),
      )
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 100));
    return rows.map(mapRow);
  }

  async countTasksByStatus(
    filter: Omit<AsyncTaskListFilter, 'limit'>,
  ): Promise<AsyncTaskStatusCount[]> {
    const rows = await this.db
      .select({
        status: pgSchema.agentAsyncTasksPostgres.status,
        count: count(),
      })
      .from(pgSchema.agentAsyncTasksPostgres)
      .where(asyncTaskFilterWhere(filter))
      .groupBy(pgSchema.agentAsyncTasksPostgres.status);
    return rows.map((row) => ({
      status: row.status as AsyncTaskStatus,
      count: row.count,
    }));
  }

  async updateTaskReceipt(
    taskId: string,
    receipt: AsyncTaskReceipt,
    now: string,
  ): Promise<AsyncTaskRecord | null> {
    const [row] = await this.db
      .update(pgSchema.agentAsyncTasksPostgres)
      .set({ receiptJson: receipt, updatedAt: now })
      .where(eq(pgSchema.agentAsyncTasksPostgres.id, taskId))
      .returning();
    return row ? mapRow(row) : null;
  }

  async transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null> {
    const updates: Partial<
      typeof pgSchema.agentAsyncTasksPostgres.$inferInsert
    > = {
      status: input.status,
      updatedAt: input.now,
    };
    if (input.heartbeatAt !== undefined)
      updates.heartbeatAt = input.heartbeatAt;
    if (input.startedAt !== undefined) updates.startedAt = input.startedAt;
    if (input.terminalAt !== undefined) updates.terminalAt = input.terminalAt;
    if (input.privateCorrelationJson !== undefined) {
      updates.privateCorrelationJson = input.privateCorrelationJson;
    }
    if (input.outputSummary !== undefined) {
      updates.outputSummary = input.outputSummary;
    }
    if (input.errorSummary !== undefined)
      updates.errorSummary = input.errorSummary;
    if (input.receiptJson !== undefined)
      updates.receiptJson = input.receiptJson;

    const [row] = await this.db
      .update(pgSchema.agentAsyncTasksPostgres)
      .set(updates)
      .where(
        and(
          eq(pgSchema.agentAsyncTasksPostgres.id, input.taskId),
          eq(pgSchema.agentAsyncTasksPostgres.leaseToken, input.leaseToken),
          eq(
            pgSchema.agentAsyncTasksPostgres.fencingVersion,
            input.fencingVersion,
          ),
          notInArray(pgSchema.agentAsyncTasksPostgres.status, [
            'completed',
            'failed',
            'cancelled',
            'timed_out',
          ]),
          input.expectedUpdatedAt
            ? eq(
                pgSchema.agentAsyncTasksPostgres.updatedAt,
                input.expectedUpdatedAt,
              )
            : undefined,
          input.expectedPrivateCorrelationJson
            ? eq(
                pgSchema.agentAsyncTasksPostgres.privateCorrelationJson,
                input.expectedPrivateCorrelationJson,
              )
            : undefined,
        ),
      )
      .returning();
    return row ? mapRow(row) : null;
  }
}

function taskInsertValues(input: AsyncTaskCreateInput) {
  return {
    id: input.id,
    appId: input.appId,
    agentId: input.agentId,
    conversationId: input.conversationId ?? null,
    threadId: input.threadId ?? null,
    parentRunId: input.parentRunId ?? null,
    parentJobId: input.parentJobId ?? null,
    parentJobRunId: input.parentJobRunId ?? null,
    kind: input.kind,
    status: input.status,
    admissionClass: input.admissionClass,
    authoritySnapshotJson: input.authoritySnapshotJson,
    privateCorrelationJson: input.privateCorrelationJson ?? {},
    leaseToken: input.leaseToken,
    fencingVersion: input.fencingVersion,
    createdAt: input.now,
    updatedAt: input.now,
    summary: input.summary ?? null,
  };
}

function scopedAdmissionLockKey(input: AsyncTaskCreateInput): string {
  return [
    'agent_async_tasks_scope',
    input.appId,
    input.agentId,
    input.kind,
    input.conversationId ?? '',
    input.threadId ?? '',
  ].join(':');
}

function asyncTaskScopeWhere(input: AsyncTaskCreateInput) {
  return and(
    eq(pgSchema.agentAsyncTasksPostgres.appId, input.appId),
    eq(pgSchema.agentAsyncTasksPostgres.agentId, input.agentId),
    eq(pgSchema.agentAsyncTasksPostgres.kind, input.kind),
    nullableEq(
      pgSchema.agentAsyncTasksPostgres.conversationId,
      input.conversationId ?? null,
    ),
    nullableEq(
      pgSchema.agentAsyncTasksPostgres.threadId,
      input.threadId ?? null,
    ),
  );
}

function asyncTaskFilterWhere(filter: Omit<AsyncTaskListFilter, 'limit'>) {
  return and(
    eq(pgSchema.agentAsyncTasksPostgres.appId, filter.appId),
    filter.agentId
      ? eq(pgSchema.agentAsyncTasksPostgres.agentId, filter.agentId)
      : undefined,
    filter.kind
      ? eq(pgSchema.agentAsyncTasksPostgres.kind, filter.kind)
      : undefined,
    filter.conversationId !== undefined
      ? nullableEq(
          pgSchema.agentAsyncTasksPostgres.conversationId,
          filter.conversationId,
        )
      : undefined,
    filter.providerAccountId !== undefined
      ? sql`coalesce(${pgSchema.agentAsyncTasksPostgres.privateCorrelationJson}->>'providerAccountId', '') = ${filter.providerAccountId ?? ''}`
      : undefined,
    filter.threadId !== undefined
      ? nullableEq(pgSchema.agentAsyncTasksPostgres.threadId, filter.threadId)
      : undefined,
    filter.parentRunId !== undefined
      ? nullableEq(
          pgSchema.agentAsyncTasksPostgres.parentRunId,
          filter.parentRunId,
        )
      : undefined,
    filter.parentTaskId !== undefined
      ? sql`${pgSchema.agentAsyncTasksPostgres.privateCorrelationJson}->>'parentTaskId' = ${filter.parentTaskId}`
      : undefined,
    filter.statuses?.length
      ? inArray(pgSchema.agentAsyncTasksPostgres.status, filter.statuses)
      : undefined,
  );
}

function mapRow(
  row: typeof pgSchema.agentAsyncTasksPostgres.$inferSelect,
): AsyncTaskRecord {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    parentRunId: row.parentRunId,
    parentJobId: row.parentJobId,
    parentJobRunId: row.parentJobRunId,
    kind: row.kind as AsyncTaskRecord['kind'],
    status: row.status as AsyncTaskRecord['status'],
    admissionClass: row.admissionClass as AsyncTaskRecord['admissionClass'],
    authoritySnapshotJson: objectJson(row.authoritySnapshotJson),
    privateCorrelationJson: objectJson(row.privateCorrelationJson),
    leaseToken: row.leaseToken,
    fencingVersion: row.fencingVersion,
    heartbeatAt: row.heartbeatAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    terminalAt: row.terminalAt,
    summary: row.summary,
    outputSummary: row.outputSummary,
    errorSummary: row.errorSummary,
    receiptJson: row.receiptJson
      ? (objectJson(row.receiptJson) as unknown as AsyncTaskReceipt)
      : null,
  };
}

function objectJson(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableEq<TColumn>(
  column: TColumn,
  value: string | null,
): ReturnType<typeof isNull> {
  return value === null
    ? isNull(column as Parameters<typeof isNull>[0])
    : eq(column as Parameters<typeof eq>[0], value as Parameters<typeof eq>[1]);
}
