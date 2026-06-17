import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const agentDelegatedTasksPostgres = pgTable(
  'agent_delegated_tasks',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    threadId: text('thread_id'),
    parentRunId: text('parent_run_id'),
    runHandle: text('run_handle'),
    idempotencyKey: text('idempotency_key').notNull(),
    capabilityScope: text('capability_scope').notNull(),
    ownerWorkerId: text('owner_worker_id'),
    leaseToken: text('lease_token'),
    fencingVersion: integer('fencing_version'),
    // status is application-constrained to:
    // running | completed | failed | cancelled.
    status: text('status').notNull().default('running'),
    providerCorrelationJson: jsonb('provider_correlation_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    progressCursor: text('progress_cursor'),
    title: text('title').notNull(),
    task: text('task').notNull(),
    expectedOutput: text('expected_output').notNull(),
    context: text('context'),
    resultSummary: text('result_summary'),
    errorSummary: text('error_summary'),
    terminalReceiptJson: jsonb('terminal_receipt_json'),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }),
    endedAt: timestamp('ended_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex('uq_agent_delegated_tasks_idempotency').on(
      table.idempotencyKey,
    ),
    agentStatusIdx: index('idx_agent_delegated_tasks_agent_status').on(
      table.appId,
      table.agentId,
      table.status,
      table.updatedAt,
    ),
    scopeIdx: index('idx_agent_delegated_tasks_scope').on(
      table.appId,
      table.agentId,
      table.conversationId,
      table.threadId,
      table.updatedAt,
    ),
    parentIdx: index('idx_agent_delegated_tasks_parent').on(
      table.parentRunId,
      table.runHandle,
      table.status,
      table.createdAt,
    ),
    activeParentIdx: index('idx_agent_delegated_tasks_active_parent')
      .on(table.parentRunId, table.runHandle, table.id)
      .where(sql`${table.status} NOT IN ('completed', 'failed', 'cancelled')`),
  }),
);

export const agentTodoUpdatesPostgres = pgTable(
  'agent_todo_updates',
  {
    id: text('id').primaryKey(),
    delegatedTaskId: text('delegated_task_id').references(
      () => agentDelegatedTasksPostgres.id,
      { onDelete: 'cascade' },
    ),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    threadId: text('thread_id'),
    parentRunId: text('parent_run_id'),
    runHandle: text('run_handle'),
    seq: integer('seq').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    fencingVersion: integer('fencing_version'),
    // kind is application-constrained to: todo_update | progress | terminal.
    kind: text('kind').notNull().default('todo_update'),
    // status is application-constrained to: accepted | replayed | rejected.
    status: text('status').notNull().default('accepted'),
    summary: text('summary'),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex('uq_agent_todo_updates_idempotency').on(
      table.idempotencyKey,
    ),
    taskSeqIdx: index('idx_agent_todo_updates_task_seq').on(
      table.delegatedTaskId,
      table.seq,
    ),
    scopeIdx: index('idx_agent_todo_updates_scope').on(
      table.appId,
      table.agentId,
      table.conversationId,
      table.threadId,
      table.createdAt,
    ),
    parentIdx: index('idx_agent_todo_updates_parent').on(
      table.parentRunId,
      table.runHandle,
      table.createdAt,
    ),
  }),
);
