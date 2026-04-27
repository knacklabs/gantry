import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { agentsPostgres } from './agents.js';
import { appsPostgres } from './apps.js';

export const browserProfilesPostgres = pgTable('browser_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agentsPostgres.id),
  label: text('label').notNull(),
  storageStateRef: text('storage_state_ref'),
  authMarkersJson: text('auth_markers_json').notNull().default('[]'),
  permissionPolicyId: text('permission_policy_id'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});
