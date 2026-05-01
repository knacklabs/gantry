import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';
import {
  sandboxProfilesPostgres,
  workspaceSnapshotsPostgres,
} from './sandbox.js';

export const llmProfilesPostgres = pgTable('llm_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  provider: text('provider').notNull().default('anthropic'),
  modelAlias: text('model_alias').notNull(),
  thinkingJson: text('thinking_json').notNull().default('{}'),
  budgetJson: text('budget_json').notNull().default('{}'),
  credentialProfileRef: text('credential_profile_ref'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const agentsPostgres = pgTable('agents', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  currentConfigVersionId: text('current_config_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const agentConfigVersionsPostgres = pgTable(
  'agent_config_versions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    promptProfileRef: text('prompt_profile_ref').notNull(),
    llmProfileId: text('llm_profile_id')
      .notNull()
      .references(() => llmProfilesPostgres.id),
    toolIdsJson: text('tool_ids_json').notNull().default('[]'),
    skillIdsJson: text('skill_ids_json').notNull().default('[]'),
    permissionPolicyIdsJson: text('permission_policy_ids_json')
      .notNull()
      .default('[]'),
    sandboxProfileId: text('sandbox_profile_id').references(
      () => sandboxProfilesPostgres.id,
    ),
    workspaceSnapshotId: text('workspace_snapshot_id').references(
      () => workspaceSnapshotsPostgres.id,
    ),
    runtimeLimitsJson: text('runtime_limits_json').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentVersion: unique('agent_config_versions_agent_id_version_unique').on(
      table.agentId,
      table.version,
    ),
  }),
);

export const agentDmAccessPostgres = pgTable(
  'agent_dm_access',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    externalUserId: text('external_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentIdx: index('idx_agent_dm_access_agent').on(table.appId, table.agentId),
    lookupIdx: index('idx_agent_dm_access_lookup').on(
      table.appId,
      table.providerId,
      table.externalUserId,
    ),
    uniqueAgentUser: uniqueIndex('uniq_agent_dm_access_user').on(
      table.appId,
      table.agentId,
      table.providerId,
      table.externalUserId,
    ),
  }),
);

export const agentDmApproversPostgres = pgTable(
  'agent_dm_approvers',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    externalUserId: text('external_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentIdx: index('idx_agent_dm_approvers_agent').on(
      table.appId,
      table.agentId,
    ),
    uniqueProviderAdmin: uniqueIndex('uniq_agent_dm_approver_provider').on(
      table.appId,
      table.agentId,
      table.providerId,
    ),
  }),
);
