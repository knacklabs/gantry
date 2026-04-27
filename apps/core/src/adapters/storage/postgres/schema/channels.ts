import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';
import {
  conversationsPostgres,
  conversationThreadsPostgres,
} from './conversations.js';
import { workspaceSnapshotsPostgres } from './sandbox.js';

export const channelProvidersPostgres = pgTable('channel_providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  capabilityFlagsJson: text('capability_flags_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const channelInstallationsPostgres = pgTable(
  'channel_installations',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => channelProvidersPostgres.id),
    externalRefJson: text('external_ref_json'),
    label: text('label').notNull(),
    status: text('status').notNull().default('active'),
    runtimeSecretRefsJson: text('runtime_secret_refs_json')
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
    providerIdx: index('idx_channel_installations_provider').on(
      table.appId,
      table.providerId,
    ),
  }),
);

export const agentChannelBindingsPostgres = pgTable(
  'agent_channel_bindings',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    channelInstallationId: text('channel_installation_id')
      .notNull()
      .references(() => channelInstallationsPostgres.id, {
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
    triggerPattern: text('trigger_pattern'),
    requiresTrigger: boolean('requires_trigger').notNull().default(true),
    isAdminBinding: boolean('is_admin_binding').notNull().default(false),
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
    conversationIdx: index('idx_agent_channel_bindings_conversation').on(
      table.conversationId,
      table.threadId,
    ),
  }),
);
