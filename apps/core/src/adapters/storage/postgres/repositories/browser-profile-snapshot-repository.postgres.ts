import { eq, sql } from 'drizzle-orm';

import type {
  BrowserProfileSnapshot,
  BrowserProfileSnapshotRepository,
  UpsertBrowserProfileSnapshotInput,
  UpsertBrowserProfileSnapshotResult,
} from '../../../../domain/ports/browser-profile-snapshot.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type BrowserProfileRow = typeof pgSchema.browserProfilesPostgres.$inferSelect;

function toSnapshot(row: BrowserProfileRow): BrowserProfileSnapshot {
  return {
    profileName: row.profileName,
    appId: row.appId ?? null,
    contentHash: row.contentHash,
    storageRef: row.storageRef,
    sizeBytes: row.sizeBytes ?? 0,
    authMarkers: Array.isArray(row.authMarkersJson)
      ? (row.authMarkersJson as string[])
      : [],
    snapshotWorkerInstanceId: row.snapshotWorkerInstanceId ?? null,
    snapshotRunId: row.snapshotRunId ?? null,
    snapshotFencingVersion: row.snapshotFencingVersion ?? 0,
    snapshottedAt: row.snapshottedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresBrowserProfileSnapshotRepository implements BrowserProfileSnapshotRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getBrowserProfileSnapshot(
    profileName: string,
  ): Promise<BrowserProfileSnapshot | null> {
    const table = pgSchema.browserProfilesPostgres;
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.profileName, profileName))
      .limit(1);
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async upsertBrowserProfileSnapshot(
    input: UpsertBrowserProfileSnapshotInput,
  ): Promise<UpsertBrowserProfileSnapshotResult> {
    const now = input.now ?? nowIso();
    const snapshottedAt = input.snapshottedAt ?? now;
    const fencingVersion = input.snapshotFencingVersion ?? 0;
    const table = pgSchema.browserProfilesPostgres;

    // Monotonic last-writer-wins guard. The conflict update applies only when
    // the incoming snapshot is NOT older than the stored row: a strictly higher
    // fencing version always wins; an equal fencing version wins only when the
    // incoming snapshotted_at is not older. A stale recovered-from writer (lower
    // fence) is rejected. `.returning()` yields a row only when the insert or
    // the guarded update actually applied; an empty result means the guard
    // rejected the write.
    const written = await this.db
      .insert(table)
      .values({
        profileName: input.profileName,
        appId: input.appId ?? null,
        contentHash: input.contentHash,
        storageRef: input.storageRef,
        sizeBytes: input.sizeBytes,
        authMarkersJson: input.authMarkers ?? [],
        snapshotWorkerInstanceId: input.snapshotWorkerInstanceId ?? null,
        snapshotRunId: input.snapshotRunId ?? null,
        snapshotFencingVersion: fencingVersion,
        snapshottedAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: table.profileName,
        set: {
          appId: input.appId ?? null,
          contentHash: input.contentHash,
          storageRef: input.storageRef,
          sizeBytes: input.sizeBytes,
          authMarkersJson: input.authMarkers ?? [],
          snapshotWorkerInstanceId: input.snapshotWorkerInstanceId ?? null,
          snapshotRunId: input.snapshotRunId ?? null,
          snapshotFencingVersion: fencingVersion,
          snapshottedAt,
          updatedAt: now,
        },
        setWhere: sql`(
          ${fencingVersion} > ${table.snapshotFencingVersion}
          OR (
            ${fencingVersion} = ${table.snapshotFencingVersion}
            AND ${snapshottedAt} >= ${table.snapshottedAt}
          )
        )`,
      })
      .returning();

    if (written[0]) {
      return { status: 'written', snapshot: toSnapshot(written[0]) };
    }
    // Guard rejected the write: a newer snapshot already exists. Read it back so
    // the caller can report what beat it.
    const current = await this.getBrowserProfileSnapshot(input.profileName);
    if (!current) {
      // Race: the row vanished between the rejected upsert and this read. Treat
      // as written-was-not-applied; surface a synthetic stale with the input.
      throw new Error(
        `Browser profile snapshot upsert for ${input.profileName} was rejected but no row exists`,
      );
    }
    return { status: 'stale', current };
  }
}
