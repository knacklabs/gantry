import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
    artifactRef: text('artifact_ref').notNull(),
    sandboxId: text('sandbox_id').references(() => sandboxProfilesPostgres.id),
    workspaceSnapshotId: text('workspace_snapshot_id').references(
      () => workspaceSnapshotsPostgres.id,
    ),
    browserProfileId: text('browser_profile_id').references(
      () => browserProfilesPostgres.id,
    ),
    providerRefJson: text('provider_ref_json').notNull().default('{}'),
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
