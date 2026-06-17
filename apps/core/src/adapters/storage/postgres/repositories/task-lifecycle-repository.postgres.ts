import { and, eq, gt } from 'drizzle-orm';

import type {
  AgentTodoUpdate,
  DelegatedTask,
  DelegatedTaskFence,
  DelegatedTaskReceipt,
  DelegatedTaskScope,
  DelegatedTaskStatus,
  TaskLifecycleRepository,
} from '../../../../domain/ports/task-lifecycle.js';
import {
  DELEGATED_TASK_TERMINAL_STATUSES,
  type AgentTodoItem,
} from '../../../../domain/ports/task-lifecycle.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { isUniqueViolation } from './worker-coordination-lease.postgres.js';

type DelegatedTaskRow =
  typeof pgSchema.agentDelegatedTasksPostgres.$inferSelect;
type TodoUpdateRow = typeof pgSchema.agentTodoUpdatesPostgres.$inferSelect;

const TERMINAL_STATUS_SET = new Set<string>(DELEGATED_TASK_TERMINAL_STATUSES);

function scopeThread(scope: DelegatedTaskScope): string | null {
  return scope.threadId?.trim() || null;
}

function scopeParentRun(scope: DelegatedTaskScope): string | null {
  return scope.parentRunId?.trim() || null;
}

function scopeRunHandle(scope: DelegatedTaskScope): string | null {
  return scope.runHandle?.trim() || null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function todoItems(value: unknown): AgentTodoItem[] {
  return Array.isArray(value)
    ? value.filter((item): item is AgentTodoItem =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)),
      )
    : [];
}

function terminalReceipt(value: unknown): DelegatedTaskReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const completed =
    typeof record.completed === 'string' ? record.completed : '';
  const used = typeof record.used === 'string' ? record.used : '';
  const changed = typeof record.changed === 'string' ? record.changed : '';
  const delegated = record.delegated === 'yes' ? 'yes' : '';
  const needsAttention =
    typeof record.needsAttention === 'string' ? record.needsAttention : '';
  if (
    !completed ||
    !used ||
    !changed ||
    delegated !== 'yes' ||
    !needsAttention
  ) {
    return null;
  }
  return { completed, used, changed, delegated, needsAttention };
}

function toDelegatedTask(row: DelegatedTaskRow): DelegatedTask {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    principalId: row.principalId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    parentRunId: row.parentRunId,
    runHandle: row.runHandle,
    idempotencyKey: row.idempotencyKey,
    capabilityScope: row.capabilityScope,
    ownerWorkerId: row.ownerWorkerId,
    leaseToken: row.leaseToken,
    fencingVersion: row.fencingVersion,
    status: row.status as DelegatedTaskStatus,
    providerCorrelation: jsonRecord(row.providerCorrelationJson),
    progressCursor: row.progressCursor,
    title: row.title,
    task: row.task,
    expectedOutput: row.expectedOutput,
    context: row.context,
    resultSummary: row.resultSummary,
    errorSummary: row.errorSummary,
    terminalReceipt: terminalReceipt(row.terminalReceiptJson),
    cancelReason: row.cancelReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function toTodoUpdate(row: TodoUpdateRow): AgentTodoUpdate {
  const payload = jsonRecord(row.payloadJson);
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    principalId: row.principalId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    parentRunId: row.parentRunId,
    runHandle: row.runHandle,
    seq: row.seq,
    summary: row.summary,
    items: todoItems(payload.items),
    createdAt: row.createdAt,
  };
}

function scopeMatches(
  row: DelegatedTaskRow,
  scope: DelegatedTaskScope,
): boolean {
  return (
    row.appId === scope.appId &&
    row.agentId === scope.agentId &&
    row.principalId === scope.principalId &&
    row.conversationId === scope.conversationId &&
    (row.threadId ?? null) === scopeThread(scope) &&
    (row.parentRunId ?? null) === scopeParentRun(scope) &&
    (row.runHandle ?? null) === scopeRunHandle(scope)
  );
}

function fenceMatches(
  row: DelegatedTaskRow,
  fence?: DelegatedTaskFence,
): boolean {
  if (!row.leaseToken && row.fencingVersion === null) return true;
  return (
    !!fence?.leaseToken &&
    row.leaseToken === fence.leaseToken &&
    row.fencingVersion === fence.fencingVersion
  );
}

async function activeFenceExists(
  executor: CanonicalExecutor,
  row: DelegatedTaskRow,
  fence: DelegatedTaskFence | undefined,
  now: string,
): Promise<boolean> {
  if (!row.parentRunId || !row.leaseToken || row.fencingVersion === null) {
    return true;
  }
  if (!fenceMatches(row, fence)) return false;
  const leases = pgSchema.runLeasesPostgres;
  const rows = await executor
    .select({ runId: leases.runId })
    .from(leases)
    .where(
      and(
        eq(leases.runId, row.parentRunId),
        eq(leases.leaseToken, row.leaseToken),
        eq(leases.fencingVersion, row.fencingVersion),
        eq(leases.status, 'active'),
        gt(leases.expiresAt, now),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export class PostgresTaskLifecycleRepository implements TaskLifecycleRepository {
  constructor(private readonly db: CanonicalDb) {}

  async recordTodoUpdate(
    input: Parameters<TaskLifecycleRepository['recordTodoUpdate']>[0],
  ) {
    const now = input.now ?? currentIso();
    const table = pgSchema.agentTodoUpdatesPostgres;
    const insert = {
      id: input.id,
      appId: input.scope.appId,
      agentId: input.scope.agentId,
      principalId: input.scope.principalId,
      conversationId: input.scope.conversationId,
      threadId: scopeThread(input.scope),
      parentRunId: scopeParentRun(input.scope),
      runHandle: scopeRunHandle(input.scope),
      seq: 1,
      idempotencyKey: input.idempotencyKey,
      fencingVersion: input.fencingVersion ?? null,
      kind: 'todo_update',
      status: 'accepted',
      summary: input.summary?.trim() || null,
      payloadJson: { items: input.items },
      createdAt: now,
    } satisfies typeof table.$inferInsert;
    try {
      const rows = await this.db.insert(table).values(insert).returning();
      return { outcome: 'created' as const, update: toTodoUpdate(rows[0]!) };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const replay = await this.findTodoByIdempotency(input.idempotencyKey);
      if (replay) {
        return { outcome: 'replayed' as const, update: replay };
      }
      throw err;
    }
  }

  async launchDelegatedTask(
    input: Parameters<TaskLifecycleRepository['launchDelegatedTask']>[0],
  ) {
    const now = input.now ?? currentIso();
    const table = pgSchema.agentDelegatedTasksPostgres;
    const insert = {
      id: input.id,
      appId: input.scope.appId,
      agentId: input.scope.agentId,
      principalId: input.scope.principalId,
      conversationId: input.scope.conversationId,
      threadId: scopeThread(input.scope),
      parentRunId: scopeParentRun(input.scope),
      runHandle: scopeRunHandle(input.scope),
      idempotencyKey: input.idempotencyKey,
      capabilityScope: input.capabilityScope,
      ownerWorkerId: input.ownerWorkerId?.trim() || null,
      leaseToken: input.fence?.leaseToken?.trim() || null,
      fencingVersion:
        typeof input.fence?.fencingVersion === 'number'
          ? Math.trunc(input.fence.fencingVersion)
          : null,
      status: 'running',
      providerCorrelationJson: {},
      progressCursor: null,
      title: input.title,
      task: input.task,
      expectedOutput: input.expectedOutput,
      context: input.context?.trim() || null,
      resultSummary: null,
      errorSummary: null,
      terminalReceiptJson: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      endedAt: null,
    } satisfies typeof table.$inferInsert;
    try {
      const rows = await this.db.insert(table).values(insert).returning();
      return { outcome: 'created' as const, task: toDelegatedTask(rows[0]!) };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const replay = await this.findTaskByIdempotency(input.idempotencyKey);
      if (replay) {
        return { outcome: 'replayed' as const, task: replay };
      }
      throw err;
    }
  }

  async getDelegatedTask(
    input: Parameters<TaskLifecycleRepository['getDelegatedTask']>[0],
  ) {
    const now = input.now ?? currentIso();
    const row = await this.getTaskRow(input.taskId, true);
    if (!row) return { outcome: 'not_found' as const };
    if (!scopeMatches(row, input.scope))
      return { outcome: 'forbidden' as const };
    if (!(await activeFenceExists(this.db, row, input.fence, now))) {
      return { outcome: 'stale_fence' as const };
    }
    return { outcome: 'found' as const, task: toDelegatedTask(row) };
  }

  async cancelDelegatedTask(
    input: Parameters<TaskLifecycleRepository['cancelDelegatedTask']>[0],
  ) {
    const now = input.now ?? currentIso();
    return this.db.transaction(async (tx) => {
      const row = await this.getTaskRow(input.taskId, true, tx);
      if (!row) return { outcome: 'not_found' as const };
      if (!scopeMatches(row, input.scope))
        return { outcome: 'forbidden' as const };
      if (!(await activeFenceExists(tx, row, input.fence, now))) {
        return { outcome: 'stale_fence' as const };
      }
      if (TERMINAL_STATUS_SET.has(row.status)) {
        return {
          outcome: 'already_terminal' as const,
          task: toDelegatedTask(row),
        };
      }
      const receipt: DelegatedTaskReceipt = {
        completed: 'Cancelled before delegated work completed.',
        used: 'AgentDelegation',
        changed: 'none',
        delegated: 'yes',
        needsAttention: 'none',
      };
      const rows = await tx
        .update(pgSchema.agentDelegatedTasksPostgres)
        .set({
          status: 'cancelled',
          cancelReason: input.reason?.trim() || null,
          terminalReceiptJson: receipt,
          resultSummary: receipt.completed,
          updatedAt: now,
          endedAt: now,
        })
        .where(eq(pgSchema.agentDelegatedTasksPostgres.id, input.taskId))
        .returning();
      return {
        outcome: 'cancelled' as const,
        task: toDelegatedTask(rows[0]!),
      };
    });
  }

  private async findTodoByIdempotency(
    idempotencyKey: string,
  ): Promise<AgentTodoUpdate | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentTodoUpdatesPostgres)
      .where(
        eq(pgSchema.agentTodoUpdatesPostgres.idempotencyKey, idempotencyKey),
      )
      .limit(1);
    return rows[0] ? toTodoUpdate(rows[0]) : null;
  }

  private async findTaskByIdempotency(
    idempotencyKey: string,
  ): Promise<DelegatedTask | null> {
    const row = await this.getTaskRowByIdempotency(idempotencyKey);
    return row ? toDelegatedTask(row) : null;
  }

  private async getTaskRowByIdempotency(
    idempotencyKey: string,
  ): Promise<DelegatedTaskRow | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentDelegatedTasksPostgres)
      .where(
        eq(pgSchema.agentDelegatedTasksPostgres.idempotencyKey, idempotencyKey),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async getTaskRow(
    taskId: string,
    lock: boolean,
    executor: CanonicalExecutor = this.db,
  ): Promise<DelegatedTaskRow | null> {
    const query = executor
      .select()
      .from(pgSchema.agentDelegatedTasksPostgres)
      .where(eq(pgSchema.agentDelegatedTasksPostgres.id, taskId))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }
}
