import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const runtimeDependenciesPostgres = pgTable(
  'runtime_dependencies',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    // Manifest hash is the bake idempotency key: one bake per (appId, hash).
    manifestHash: text('manifest_hash').notNull(),
    requestedPackagesJson: jsonb('requested_packages_json')
      .notNull()
      .default([]),
    // status is application-constrained to:
    // queued | baking | uploaded | activated | failed.
    status: text('status').notNull().default('queued'),
    storageType: text('storage_type'),
    storageRef: text('storage_ref'),
    contentHash: text('content_hash'),
    sizeBytes: integer('size_bytes'),
    failureReason: text('failure_reason'),
    requestedByAgentId: text('requested_by_agent_id'),
    approvedByConversationId: text('approved_by_conversation_id'),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    // One manifest per (appId, hash); concurrent bake requests for the same
    // manifest collapse onto this row.
    appManifestUnique: uniqueIndex('uq_runtime_dependencies_app_manifest').on(
      table.appId,
      table.manifestHash,
    ),
    appStatusIdx: index('idx_runtime_dependencies_app_status').on(
      table.appId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const settingsRevisionsPostgres = pgTable(
  'settings_revisions',
  {
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    // Monotonic per appId; allocated transactionally on append.
    revision: integer('revision').notNull(),
    settingsDocumentJson: jsonb('settings_document_json').notNull(),
    // A worker older than this version holds its last-applied revision and
    // alerts rather than mis-applying state it cannot parse.
    minReaderVersion: integer('min_reader_version').notNull().default(0),
    createdBy: text('created_by').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.appId, table.revision],
      name: 'settings_revisions_pk',
    }),
    appCreatedIdx: index('idx_settings_revisions_app_created').on(
      table.appId,
      table.createdAt,
    ),
  }),
);
