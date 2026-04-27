import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const toolCatalogPostgres = pgTable(
  'tool_catalog',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    inputSchemaJson: text('input_schema_json').notNull().default('{}'),
    outputSchemaJson: text('output_schema_json').notNull().default('{}'),
    risk: text('risk').notNull(),
    permissionPolicyId: text('permission_policy_id'),
    sandboxProfileId: text('sandbox_profile_id'),
    adapterRef: text('adapter_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appNameUnique: uniqueIndex('idx_tool_catalog_app_name').on(
      table.appId,
      table.name,
    ),
  }),
);

export const agentToolBindingsPostgres = pgTable(
  'agent_tool_bindings',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    toolId: text('tool_id')
      .notNull()
      .references(() => toolCatalogPostgres.id, { onDelete: 'cascade' }),
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
    agentToolUnique: uniqueIndex('idx_agent_tool_bindings_unique').on(
      table.agentId,
      table.toolId,
      table.configVersionId,
    ),
  }),
);
