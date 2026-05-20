import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
    scopeKey: text('scope_key'),
    latestProviderSessionId: text('latest_provider_session_id'),
    status: text('status').notNull().default('active'),
    model: text('model_override'),
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
    appScopeKeyIdx: index('idx_agent_sessions_app_scope_key').on(
      table.appId,
      table.scopeKey,
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
    sandboxId: text('sandbox_id').references(() => sandboxProfilesPostgres.id),
    workspaceSnapshotId: text('workspace_snapshot_id').references(
      () => workspaceSnapshotsPostgres.id,
    ),
    browserProfileId: text('browser_profile_id').references(
      () => browserProfilesPostgres.id,
    ),
    providerRefJson: jsonb('provider_ref_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadataJson: jsonb('metadata_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    resumeLookupIdx: index('idx_provider_sessions_resume_lookup').on(
      table.agentSessionId,
      table.provider,
      table.status,
      table.updatedAt.desc(),
    ),
    agentProviderIdx: index('idx_provider_sessions_agent_provider').on(
      table.agentSessionId,
      table.provider,
    ),
    providerAgnosticResumeLookupIdx: index(
      'idx_provider_sessions_agent_status_updated',
    ).on(table.agentSessionId, table.status, table.updatedAt.desc()),
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

export const agentSessionDigestsPostgres = pgTable(
  'agent_session_digests',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentSessionId: text('agent_session_id')
      .notNull()
      .references(() => agentSessionsPostgres.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    digest: text('digest').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    extractedFactCount: integer('extracted_fact_count').notNull().default(0),
    metadataJson: jsonb('metadata_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    scopeAppId: text('scope_app_id'),
    scopeAgentId: text('scope_agent_id'),
    scopeConversationId: text('scope_conversation_id'),
    scopeUserId: text('scope_user_id'),
    scopeThreadId: text('scope_thread_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index('idx_agent_session_digests_session_created').on(
      table.agentSessionId,
      table.createdAt,
      table.id,
    ),
    sessionTriggerIdx: index('idx_agent_session_digests_session_trigger').on(
      table.agentSessionId,
      table.trigger,
      table.createdAt,
    ),
    sessionScopeCreatedIdx: index('idx_agent_session_digests_scope_created').on(
      table.agentSessionId,
      table.scopeAppId,
      table.scopeAgentId,
      table.scopeConversationId,
      table.scopeUserId,
      table.scopeThreadId,
      table.createdAt,
      table.id,
    ),
  }),
);
