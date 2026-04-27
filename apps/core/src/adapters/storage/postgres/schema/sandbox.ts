import { pgTable, text, timestamp, integer } from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';
import { permissionDecisionsPostgres } from './permissions.js';
import { agentRunsPostgres } from './runs.js';

export const sandboxProfilesPostgres = pgTable('sandbox_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  filesystem: text('filesystem').notNull(),
  network: text('network').notNull(),
  process: text('process').notNull(),
  browser: text('browser').notNull(),
  credentialAccess: text('credential_access').notNull(),
  timeoutMs: integer('timeout_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const workspaceSnapshotsPostgres = pgTable('workspace_snapshots', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  rootRef: text('root_ref').notNull(),
  mountsJson: text('mounts_json').notNull().default('[]'),
  promptRefsJson: text('prompt_refs_json').notNull().default('[]'),
  contextRefsJson: text('context_refs_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const sandboxLeasesPostgres = pgTable('sandbox_leases', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  profileId: text('profile_id')
    .notNull()
    .references(() => sandboxProfilesPostgres.id),
  runId: text('run_id')
    .notNull()
    .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
  permissionDecisionId: text('permission_decision_id')
    .notNull()
    .references(() => permissionDecisionsPostgres.id),
  status: text('status').notNull(),
  grantedAt: timestamp('granted_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
});
