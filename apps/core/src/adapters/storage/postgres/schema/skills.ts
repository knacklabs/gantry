import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const skillCatalogPostgres = pgTable(
  'skill_catalog',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    description: text('description'),
    version: text('version').notNull(),
    source: text('source').notNull().default('bundled'),
    status: text('status').notNull().default('approved'),
    promptRefsJson: text('prompt_refs_json').notNull().default('[]'),
    toolIdsJson: text('tool_ids_json').notNull().default('[]'),
    workflowRefsJson: text('workflow_refs_json').notNull().default('[]'),
    storageType: text('storage_type'),
    storageRef: text('storage_ref'),
    contentHash: text('content_hash'),
    sizeBytes: integer('size_bytes'),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    rejectedBy: text('rejected_by'),
    rejectedAt: timestamp('rejected_at', {
      withTimezone: true,
      mode: 'string',
    }),
    provider: text('provider'),
    providerSkillId: text('provider_skill_id'),
    providerSkillType: text('provider_skill_type'),
    providerSkillVersion: text('provider_skill_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appNameVersionUnique: uniqueIndex('idx_skill_catalog_app_name_version').on(
      table.appId,
      sql`coalesce(${table.agentId}, '')`,
      table.name,
      table.version,
    ),
    appStatusIdx: index('idx_skill_catalog_app_status').on(
      table.appId,
      table.status,
    ),
    appAgentStatusIdx: index('idx_skill_catalog_app_agent_status').on(
      table.appId,
      table.agentId,
      table.status,
    ),
    appHashUnique: uniqueIndex('idx_skill_catalog_app_hash').on(
      table.appId,
      sql`coalesce(${table.agentId}, '')`,
      table.contentHash,
    ),
  }),
);

export const agentSkillBindingsPostgres = pgTable(
  'agent_skill_bindings',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skillCatalogPostgres.id, { onDelete: 'cascade' }),
    configVersionId: text('config_version_id'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentSkillUnique: uniqueIndex('idx_agent_skill_bindings_unique').on(
      table.appId,
      table.agentId,
      table.skillId,
    ),
  }),
);
