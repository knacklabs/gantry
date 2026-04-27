import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import {
  agentConfigVersionsPostgres,
  agentsPostgres,
  llmProfilesPostgres,
} from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { messagesPostgres } from './messages.js';
import { agentSessionsPostgres } from './sessions.js';

export const agentRunsPostgres = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
  configVersionId: text('config_version_id')
    .notNull()
    .references(() => agentConfigVersionsPostgres.id),
  sessionId: text('session_id').references(() => agentSessionsPostgres.id),
  conversationId: text('conversation_id').references(
    () => conversationsPostgres.id,
  ),
  threadId: text('thread_id').references(() => conversationThreadsPostgres.id),
  messageId: text('message_id').references(() => messagesPostgres.id),
  jobId: text('job_id'),
  llmProfileId: text('llm_profile_id')
    .notNull()
    .references(() => llmProfilesPostgres.id),
  permissionDecisionIdsJson: text('permission_decision_ids_json')
    .notNull()
    .default('[]'),
  sandboxLeaseId: text('sandbox_lease_id'),
  workspaceSnapshotId: text('workspace_snapshot_id'),
  cause: text('cause').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
  resultSummary: text('result_summary'),
  errorSummary: text('error_summary'),
});

export const agentRunEventsPostgres = pgTable(
  'agent_run_events',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runCursorIdx: index('idx_agent_run_events_run_cursor').on(
      table.runId,
      table.createdAt,
      table.id,
    ),
  }),
);
