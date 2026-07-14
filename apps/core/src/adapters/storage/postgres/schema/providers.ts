import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { workspaceSnapshotsPostgres } from './sandbox.js';

export const providersPostgres = pgTable('providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  capabilityFlagsJson: text('capability_flags_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const providerAccountsPostgres = pgTable(
  'provider_accounts',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providersPostgres.id),
    externalIdentityRefJson: text('external_identity_ref_json'),
    label: text('label').notNull(),
    status: text('status').notNull().default('active'),
    configJson: text('config_json').notNull().default('{}'),
    runtimeSecretRefsJson: text('runtime_secret_refs_json')
      .notNull()
      .default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerIdx: index('idx_provider_accounts_provider').on(
      table.appId,
      table.providerId,
    ),
    agentIdx: index('idx_provider_accounts_agent').on(
      table.appId,
      table.agentId,
    ),
    activeIdentityUnique: uniqueIndex('uniq_provider_accounts_active_identity')
      .on(table.appId, table.providerId, table.externalIdentityRefJson)
      .where(
        sql`${table.status} = 'active' AND ${table.externalIdentityRefJson} IS NOT NULL`,
      ),
  }),
);

export const conversationInstallsPostgres = pgTable(
  'conversation_installs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id')
      .notNull()
      .references(() => providerAccountsPostgres.id, {
        onDelete: 'cascade',
      }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
      { onDelete: 'cascade' },
    ),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('active'),
    senderPolicy: text('sender_policy').notNull().default('provider_native'),
    controlPolicy: text('control_policy')
      .notNull()
      .default('conversation_approvers'),
    memoryScope: text('memory_scope').notNull().default('conversation'),
    memorySubjectJson: text('memory_subject_json').notNull(),
    workspaceSnapshotId: text('workspace_snapshot_id').references(
      () => workspaceSnapshotsPostgres.id,
    ),
    permissionPolicyIdsJson: text('permission_policy_ids_json')
      .notNull()
      .default('[]'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index('idx_conversation_installs_conversation').on(
      table.conversationId,
      table.threadId,
    ),
    accountIdx: index('idx_conversation_installs_account').on(
      table.providerAccountId,
    ),
  }),
);
