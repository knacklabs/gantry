import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const skillCatalogPostgres = pgTable(
  'skill_catalog',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    version: text('version').notNull(),
    promptRefsJson: text('prompt_refs_json').notNull().default('[]'),
    toolIdsJson: text('tool_ids_json').notNull().default('[]'),
    workflowRefsJson: text('workflow_refs_json').notNull().default('[]'),
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
      table.name,
      table.version,
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
      table.agentId,
      table.skillId,
      table.configVersionId,
    ),
  }),
);
