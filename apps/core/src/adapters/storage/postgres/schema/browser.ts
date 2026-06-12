import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { agentRunsPostgres } from './runs.js';

/**
 * Durable cross-worker browser profile snapshot index. One row per profile name
 * (the per-conversation profile identity resolved by
 * resolveConversationBrowserProfile). A live/job turn that used the browser
 * snapshots its `user-data/` tree at turn end; a worker admitting the same
 * conversation elsewhere restores it before Chrome launch. The bytes live in the
 * BrowserProfileArtifactStore (local FS or S3); this table records the current
 * content hash + storage ref + the snapshotting worker's lease fence so a stale
 * recovered writer can never overwrite a newer snapshot (monotonic
 * last-writer-wins, keyed on fencing version then timestamp).
 */
export const browserProfilesPostgres = pgTable(
  'browser_profiles',
  {
    profileName: text('profile_name').primaryKey(),
    // Nullable: the snapshot call sites (live finalize, job cleanup, browser
    // launch) hold the agent folder + profile name, not always a resolved
    // app_id. The profile name is the durable identity; app_id is metadata.
    appId: text('app_id'),
    contentHash: text('content_hash').notNull(),
    storageRef: text('storage_ref').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    authMarkersJson: jsonb('auth_markers_json')
      .notNull()
      .default(sql`'[]'::jsonb`),
    snapshotWorkerInstanceId: text('snapshot_worker_instance_id'),
    snapshotRunId: text('snapshot_run_id').references(
      () => agentRunsPostgres.id,
      { onDelete: 'set null' },
    ),
    // Monotonic per profile. The upsert applies only when the incoming
    // (fencing_version, snapshotted_at) is not older than the stored row, so a
    // recovered-at-higher-fence owner beats a stale one.
    snapshotFencingVersion: integer('snapshot_fencing_version')
      .notNull()
      .default(0),
    snapshottedAt: timestamp('snapshotted_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
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
    appIdx: index('idx_browser_profiles_app').on(table.appId, table.updatedAt),
  }),
);
