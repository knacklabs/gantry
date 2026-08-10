import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres, usersPostgres } from './apps.js';

export const toolCatalogPostgres = pgTable(
  'tool_catalog',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('host'),
    provider: text('provider').notNull().default('gantry'),
    providerToolName: text('provider_tool_name'),
    displayName: text('display_name').notNull().default(''),
    description: text('description'),
    category: text('category').notNull().default('admin'),
    inputSchemaJson: text('input_schema_json').notNull().default('{}'),
    outputSchemaJson: text('output_schema_json').notNull().default('{}'),
    risk: text('risk').notNull(),
    selectable: boolean('selectable').notNull().default(true),
    status: text('status').notNull().default('active'),
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
    personId: text('person_id'),
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
    personAppScoped: foreignKey({
      name: 'agent_tool_bindings_app_person_fk',
      columns: [table.appId, table.personId],
      foreignColumns: [usersPostgres.appId, usersPostgres.id],
    }).onDelete('cascade'),
    agentToolUnique: unique('idx_agent_tool_bindings_unique')
      .on(table.agentId, table.toolId, table.configVersionId, table.personId)
      .nullsNotDistinct(),
  }),
);

export const agentToolSourcesPostgres = pgTable(
  'agent_tool_sources',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    kind: text('kind').notNull(),
    version: text('version').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentToolSourceUnique: uniqueIndex('idx_agent_tool_sources_unique').on(
      table.appId,
      table.agentId,
      table.sourceId,
      table.kind,
      table.version,
    ),
    agentToolSourceAppAgentStatusIdx: index(
      'idx_agent_tool_sources_app_agent_status',
    ).on(
      table.appId,
      table.agentId,
      table.status,
      table.sourceId,
      table.kind,
      table.version,
      table.updatedAt,
    ),
  }),
);
