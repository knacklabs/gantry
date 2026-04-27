import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { browserProfilesPostgres } from './browser.js';
import {
  sandboxProfilesPostgres,
  workspaceSnapshotsPostgres,
} from './sandbox.js';

export const agentSessionsPostgres = pgTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(
      () => conversationsPostgres.id,
    ),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
    ),
    jobId: text('job_id'),
    userId: text('user_id'),
    latestProviderSessionId: text('latest_provider_session_id'),
    status: text('status').notNull().default('active'),
    modelOverride: text('model_override'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    resetAt: timestamp('reset_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => ({
    ownerIdx: index('idx_agent_sessions_owner').on(
      table.appId,
      table.agentId,
      table.conversationId,
      table.threadId,
      table.userId,
    ),
  }),
);

export const providerSessionsPostgres = pgTable(
  'provider_sessions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentSessionId: text('agent_session_id')
      .notNull()
      .references(() => agentSessionsPostgres.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalSessionId: text('external_session_id').notNull(),
    artifactRef: text('artifact_ref'),
    sandboxId: text('sandbox_id').references(() => sandboxProfilesPostgres.id),
    workspaceSnapshotId: text('workspace_snapshot_id').references(
      () => workspaceSnapshotsPostgres.id,
    ),
    browserProfileId: text('browser_profile_id').references(
      () => browserProfilesPostgres.id,
    ),
    providerRefJson: text('provider_ref_json').notNull().default('{}'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerExternalIdx: index('idx_provider_sessions_external').on(
      table.provider,
      table.externalSessionId,
    ),
  }),
);

export const agentSessionSummariesPostgres = pgTable(
  'agent_session_summaries',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentSessionId: text('agent_session_id')
      .notNull()
      .references(() => agentSessionsPostgres.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    source: text('source').notNull().default('extractive'),
    fromMessageId: text('from_message_id'),
    toMessageId: text('to_message_id'),
    fromRunId: text('from_run_id'),
    toRunId: text('to_run_id'),
    messageCount: integer('message_count').notNull().default(0),
    runCount: integer('run_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index('idx_agent_session_summaries_session_created').on(
      table.agentSessionId,
      table.createdAt,
      table.id,
    ),
  }),
);
