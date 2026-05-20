import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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

export const agentRunsPostgres = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    shortId: integer('short_id'),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    configVersionId: text('config_version_id')
      .notNull()
      .references(() => agentConfigVersionsPostgres.id),
    sessionId: text('session_id').references(() => agentSessionsPostgres.id, {
      onDelete: 'set null',
    }),
    conversationId: text('conversation_id').references(
      () => conversationsPostgres.id,
    ),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
    ),
    messageId: text('message_id').references(() => messagesPostgres.id),
    jobId: text('job_id'),
    llmProfileId: text('llm_profile_id')
      .notNull()
      .references(() => llmProfilesPostgres.id),
    executionProviderId: text('execution_provider_id').notNull(),
    providerRunId: text('provider_run_id'),
    providerSessionId: text('provider_session_id'),
    workerId: text('worker_id'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
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
    notifiedAt: timestamp('notified_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    jobStartedIdx: index('idx_agent_runs_job_started').on(
      table.jobId,
      table.startedAt.desc().nullsLast(),
      table.createdAt.desc(),
    ),
    jobShortIdUnique: uniqueIndex('idx_agent_runs_job_short_id_unique').on(
      table.jobId,
      table.shortId,
    ),
    startedCreatedIdx: index('idx_agent_runs_started_created').on(
      table.startedAt.desc().nullsLast(),
      table.createdAt.desc(),
    ),
    providerSessionIdx: index('idx_agent_runs_provider_session').on(
      table.providerSessionId,
    ),
    leaseClaimIdx: index('idx_agent_runs_lease_claim')
      .on(table.status, table.leaseExpiresAt, table.leaseOwner)
      .where(sql`${table.status} IN ('pending', 'leased')`),
  }),
);
