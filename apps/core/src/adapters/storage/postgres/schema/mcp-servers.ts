import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const mcpServersPostgres = pgTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    displayName: text('display_name'),
    description: text('description'),
    status: text('status').notNull().default('active'),
    createdSource: text('created_source').notNull().default('admin'),
    riskClass: text('risk_class').notNull().default('medium'),
    requestedBy: text('requested_by'),
    requestedReason: text('requested_reason'),
    transport: text('transport').notNull().default('stdio_template'),
    configJson: text('config_json').notNull().default('{}'),
    allowedToolPatternsJson: text('allowed_tool_patterns_json')
      .notNull()
      .default('[]'),
    autoApproveToolPatternsJson: text('auto_approve_tool_patterns_json')
      .notNull()
      .default('[]'),
    credentialRefsJson: text('credential_refs_json').notNull().default('[]'),
    networkHostsJson: text('network_hosts_json').notNull().default('[]'),
    sandboxProfileId: text('sandbox_profile_id'),
    disabledBy: text('disabled_by'),
    disabledAt: timestamp('disabled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appNameUnique: uniqueIndex('idx_mcp_servers_app_name').on(
      table.appId,
      table.name,
    ),
    appStatusUpdatedIdx: index('idx_mcp_servers_app_status_updated').on(
      table.appId,
      table.status,
      table.updatedAt.desc(),
    ),
  }),
);

export const agentMcpServerBindingsPostgres = pgTable(
  'agent_mcp_server_bindings',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => mcpServersPostgres.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    required: boolean('required').notNull().default(false),
    permissionPolicyIdsJson: text('permission_policy_ids_json')
      .notNull()
      .default('[]'),
    allowedToolPatternsJson: text('allowed_tool_patterns_json')
      .notNull()
      .default('[]'),
    conversationId: text('conversation_id'),
    threadId: text('thread_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentServerUnique: uniqueIndex('idx_agent_mcp_server_bindings_unique').on(
      table.appId,
      table.agentId,
      table.serverId,
    ),
    agentStatusIdx: index('idx_agent_mcp_server_bindings_agent_status').on(
      table.appId,
      table.agentId,
      table.status,
    ),
  }),
);

export const mcpServerAuditEventsPostgres = pgTable(
  'mcp_server_audit_events',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agentsPostgres.id, {
      onDelete: 'set null',
    }),
    serverId: text('server_id').references(() => mcpServersPostgres.id, {
      onDelete: 'set null',
    }),
    bindingId: text('binding_id').references(
      () => agentMcpServerBindingsPostgres.id,
      {
        onDelete: 'set null',
      },
    ),
    eventType: text('event_type').notNull(),
    actorId: text('actor_id'),
    reason: text('reason'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appServerCreatedIdx: index(
      'idx_mcp_server_audit_events_app_server_created',
    ).on(table.appId, table.serverId, table.createdAt.desc()),
    appCreatedIdx: index('idx_mcp_server_audit_events_app_created').on(
      table.appId,
      table.createdAt,
    ),
  }),
);
