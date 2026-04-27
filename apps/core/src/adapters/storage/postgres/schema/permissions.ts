import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';
import { agentRunsPostgres } from './runs.js';
import { toolCatalogPostgres } from './tools.js';

export const permissionPoliciesPostgres = pgTable('permission_policies', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const permissionRulesPostgres = pgTable('permission_rules', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  policyId: text('policy_id')
    .notNull()
    .references(() => permissionPoliciesPostgres.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull(),
  effect: text('effect').notNull(),
  matchJson: text('match_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const permissionDecisionsPostgres = pgTable('permission_decisions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  policyId: text('policy_id').references(() => permissionPoliciesPostgres.id),
  ruleIdsJson: text('rule_ids_json').notNull().default('[]'),
  runId: text('run_id').references(() => agentRunsPostgres.id),
  toolId: text('tool_id').references(() => toolCatalogPostgres.id),
  effect: text('effect').notNull(),
  reason: text('reason').notNull(),
  approverRef: text('approver_ref'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const permissionAuditEventsPostgres = pgTable(
  'permission_audit_events',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    decisionId: text('decision_id').references(
      () => permissionDecisionsPostgres.id,
      { onDelete: 'set null' },
    ),
    actorId: text('actor_id'),
    eventType: text('event_type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
);
