import { sql } from 'drizzle-orm';
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
    source: text('source').notNull().default('bundled'),
    status: text('status').notNull().default('installed'),
    promptRefsJson: text('prompt_refs_json').notNull().default('[]'),
    toolIdsJson: text('tool_refs_json').notNull().default('[]'),
    workflowRefsJson: text('workflow_refs_json').notNull().default('[]'),
    requiredEnvVarsJson: text('required_env_vars_json').notNull().default('[]'),
    actionPermissionsJson: jsonb('action_permissions_json')
      .notNull()
      .default(sql`'[]'::jsonb`),
    storageType: text('storage_type'),
    storageRef: text('storage_ref'),
    contentHash: text('content_hash'),
    sizeBytes: integer('size_bytes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appStatusIdx: index('idx_skill_catalog_app_status').on(
      table.appId,
      table.status,
    ),
    appAgentStatusIdx: index('idx_skill_catalog_app_agent_status').on(
      table.appId,
      table.agentId,
      table.status,
    ),
    appSkillSlugUnique: uniqueIndex(
      'idx_skill_catalog_app_skill_slug_installed',
    )
      .on(
        table.appId,
        sql`lower(regexp_replace(regexp_replace(trim(${table.name}), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))`,
      )
      .where(sql`${table.status} = 'installed'`),
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
