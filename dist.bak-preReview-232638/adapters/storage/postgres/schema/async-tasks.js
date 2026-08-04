import { index, integer, jsonb, pgTable, text, timestamp, } from 'drizzle-orm/pg-core';
import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import { canonicalJobsPostgres, jobRunsPostgres } from './jobs.js';
import { agentRunsPostgres } from './runs.js';
export const agentAsyncTasksPostgres = pgTable('agent_async_tasks', {
    id: text('id').primaryKey(),
    appId: text('app_id')
        .notNull()
        .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
        .notNull()
        .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    threadId: text('thread_id'),
    parentRunId: text('parent_run_id').references(() => agentRunsPostgres.id),
    parentJobId: text('parent_job_id').references(() => canonicalJobsPostgres.id),
    parentJobRunId: text('parent_job_run_id').references(() => jobRunsPostgres.id),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    admissionClass: text('admission_class').notNull(),
    authoritySnapshotJson: jsonb('authority_snapshot_json').notNull(),
    privateCorrelationJson: jsonb('private_correlation_json').notNull(),
    leaseToken: text('lease_token').notNull(),
    fencingVersion: integer('fencing_version').notNull().default(1),
    heartbeatAt: timestamp('heartbeat_at', {
        withTimezone: true,
        mode: 'string',
    }),
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
    terminalAt: timestamp('terminal_at', {
        withTimezone: true,
        mode: 'string',
    }),
    summary: text('summary'),
    outputSummary: text('output_summary'),
    errorSummary: text('error_summary'),
    receiptJson: jsonb('receipt_json'),
}, (table) => ({
    appStatusUpdatedIdx: index('idx_agent_async_tasks_app_status_updated').on(table.appId, table.status, table.updatedAt),
    scopeUpdatedIdx: index('idx_agent_async_tasks_scope_updated').on(table.appId, table.agentId, table.conversationId, table.threadId, table.updatedAt),
    parentRunIdx: index('idx_agent_async_tasks_parent_run').on(table.parentRunId, table.updatedAt),
    parentJobRunIdx: index('idx_agent_async_tasks_parent_job_run').on(table.parentJobRunId, table.updatedAt),
}));
