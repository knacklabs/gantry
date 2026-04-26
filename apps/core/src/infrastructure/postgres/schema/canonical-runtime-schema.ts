import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import {
  agentRunsPostgres,
  agentsPostgres,
  appsPostgres,
} from './canonical-schema.js';

export const canonicalJobsPostgres = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    modelOverride: text('model_override'),
    scheduleJson: text('schedule_json').notNull(),
    status: text('status').notNull().default('active'),
    executionMode: text('execution_mode').notNull().default('parallel'),
    targetJson: text('target_json').notNull().default('{}'),
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

export const canonicalMemorySubjectsPostgres = pgTable('memory_subjects', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  externalRefJson: text('external_ref_json').notNull().default('{}'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
});

export const canonicalMemoryItemsPostgres = pgTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id')
      .notNull()
      .references(() => canonicalMemorySubjectsPostgres.id, {
        onDelete: 'cascade',
      }),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    confidence: doublePrecision('confidence').notNull().default(1),
    sourceRefJson: text('source_ref_json').notNull().default('{}'),
    status: text('status').notNull().default('active'),
    lastObservedAt: timestamp('last_observed_at', {
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
    subjectKeyIdx: uniqueIndex('idx_memory_items_subject_kind_key').on(
      table.subjectId,
      table.kind,
      table.key,
    ),
    subjectUpdatedIdx: index('idx_memory_items_subject_updated').on(
      table.subjectId,
      table.status,
      table.updatedAt,
    ),
  }),
);
