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
import { canonicalJobsPostgres } from './jobs.js';
import { agentRunsPostgres } from './runs.js';

export const jobSemanticCheckpointsPostgres = pgTable(
  'job_semantic_checkpoints',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => canonicalJobsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    workerInstanceId: text('worker_instance_id').notNull(),
    fencingVersion: integer('fencing_version').notNull(),
    milestone: text('milestone').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    payloadHash: text('payload_hash').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runSequenceUnique: uniqueIndex(
      'uq_job_semantic_checkpoints_run_sequence',
    ).on(table.runId, table.sequence),
    scopeSequenceIdx: index('idx_job_semantic_checkpoints_scope_sequence').on(
      table.appId,
      table.agentId,
      table.jobId,
      table.runId,
      table.sequence,
    ),
  }),
);
