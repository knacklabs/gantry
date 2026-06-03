import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { agentRunsPostgres } from './runs.js';

export const canonicalJobsPostgres = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'set null',
    }),
    conversationId: text('conversation_id').references(
      () => conversationsPostgres.id,
    ),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
    ),
    createdByActorId: text('created_by_actor_id').notNull(),
    createdBySource: text('created_by_source').notNull(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    model: text('model_override'),
    scheduleJson: jsonb('schedule_json').notNull(),
    status: text('status').notNull().default('active'),
    targetJson: jsonb('target_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    silent: boolean('silent').notNull().default(false),
    timeoutMs: integer('timeout_ms').notNull().default(300000),
    maxRetries: integer('max_retries').notNull().default(3),
    retryBackoffMs: integer('retry_backoff_ms').notNull().default(5000),
    nextRunAt: timestamp('next_run_at', {
      withTimezone: true,
      mode: 'string',
    }),
    lastRunAt: timestamp('last_run_at', {
      withTimezone: true,
      mode: 'string',
    }),
    leaseRunId: text('lease_run_id').references(() => agentRunsPostgres.id),
    leaseExpiresAt: timestamp('lease_expires_at', {
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
  },
  (table) => ({
    appStatusNextRunIdx: index('idx_jobs_app_status_next_run').on(
      table.appId,
      table.status,
      table.nextRunAt,
    ),
    targetSessionUpdatedIdx: index('idx_jobs_target_session_updated').on(
      sql`(${table.targetJson} #>> '{executionContext,sessionId}')`,
      table.updatedAt.desc(),
      table.createdAt.desc(),
    ),
    targetWorkspaceKeyUpdatedIdx: index(
      'idx_jobs_target_workspace_key_updated',
    ).on(
      sql`(${table.targetJson} #>> '{executionContext,workspaceKey}')`,
      table.updatedAt.desc(),
      table.createdAt.desc(),
    ),
    targetThreadNormalizedUpdatedIdx: index(
      'idx_jobs_target_thread_normalized_updated',
    ).on(
      sql`coalesce(${table.targetJson} #>> '{executionContext,threadId}', '')`,
      table.updatedAt.desc(),
      table.createdAt.desc(),
    ),
    targetNotificationRoutesGinIdx: index(
      'idx_jobs_target_notification_routes',
    ).using(
      'gin',
      sql`(coalesce(${table.targetJson} -> 'notificationRoutes', '[]'::jsonb)) jsonb_path_ops`,
    ),
  }),
);

export const jobRunsPostgres = pgTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => canonicalJobsPostgres.id, { onDelete: 'cascade' }),
    agentRunId: text('agent_run_id').references(() => agentRunsPostgres.id),
    status: text('status').notNull(),
    scheduledFor: timestamp('scheduled_for', {
      withTimezone: true,
      mode: 'string',
    }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    resultSummary: text('result_summary'),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    jobIdx: index('idx_job_runs_job').on(table.jobId, table.createdAt),
  }),
);

export const canonicalJobTriggersPostgres = pgTable('job_triggers', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  jobId: text('job_id')
    .notNull()
    .references(() => canonicalJobsPostgres.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => agentRunsPostgres.id),
  requestedBy: text('requested_by').notNull(),
  requestedAt: timestamp('requested_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
});
