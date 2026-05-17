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

export const fileArtifactsPostgres = pgTable(
  'file_artifacts',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    virtualScope: text('virtual_scope').notNull(),
    virtualPath: text('virtual_path').notNull(),
    version: integer('version').notNull(),
    storageType: text('storage_type').notNull(),
    storageRef: text('storage_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentType: text('content_type').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdBy: text('created_by'),
    promotedFromArtifactId: text('promoted_from_artifact_id').references(
      (): never => fileArtifactsPostgres.id as never,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => ({
    versionUniqueIdx: uniqueIndex('idx_file_artifacts_version_unique').on(
      table.appId,
      table.agentId,
      table.virtualScope,
      table.virtualPath,
      table.version,
    ),
    scopeIdx: index('idx_file_artifacts_scope').on(
      table.appId,
      table.agentId,
      table.virtualScope,
      table.createdAt,
    ),
  }),
);
