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
    snapshotLeaseGeneration: row.snapshotLeaseGeneration ?? 0,
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
    return this.getBrowserProfileSnapshotWith(this.db, profileName);
  }

  private async getBrowserProfileSnapshotWith(
    db: CanonicalDb,
    profileName: string,
  ): Promise<BrowserProfileSnapshot | null> {
    const table = pgSchema.browserProfilesPostgres;
    const rows = await db
      .select()
      .from(table)
      .where(eq(table.profileName, profileName))
      .limit(1);
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async upsertBrowserProfileSnapshot(
    input: UpsertBrowserProfileSnapshotInput,
  ): Promise<UpsertBrowserProfileSnapshotResult> {
    // The fence check must be SERIALIZED with generation advancement, not just
    // placed in the same statement: a scalar subquery only sees the statement's
    // MVCC snapshot, so a successor that commits a bump mid-write could still be
    // invisible here and the stale write would publish. Taking a row lock on the
    // generation makes the bump (an UPDATE of that row) wait for this commit.
    return this.db.transaction((tx) =>
      this.upsertWithinTransaction(tx as unknown as CanonicalDb, input),
    );
  }

  private async upsertWithinTransaction(
    db: CanonicalDb,
    input: UpsertBrowserProfileSnapshotInput,
  ): Promise<UpsertBrowserProfileSnapshotResult> {
    const now = input.now ?? nowIso();
    const snapshottedAt = input.snapshottedAt ?? now;
    const fencingVersion = input.snapshotFencingVersion ?? 0;
    const leaseGeneration = input.snapshotLeaseGeneration ?? 0;
    // The write must carry EXACTLY the generation currently issued for this
    // lease key.
    //
    // Lower is the stale-owner case a row-relative check misses: a successor
    // that acquired the lease but has not published yet leaves the row behind,
    // so comparing against the row would accept the previous owner's delayed
    // write. HIGHER is rejected too — no legitimate holder can hold a token
    // that was never issued, and letting one through would write an
    // arbitrarily high durable fence that blocks every real owner until the
    // counter catches up. Only the launch path advances the generation; cleanup
    // and snapshots take the lock SHARED, so the issued value cannot move while
    // a publisher holds it.
    //
    // Evaluated in the same statement as the write, so a concurrent
    // acquisition cannot slip between a read and the update.
    if (input.leaseKey) {
      const generations = pgSchema.runtimeLeaseGenerationsPostgres;
      // Ensure a row exists so there is something to lock: without it a
      // concurrent first-ever acquisition could INSERT one this transaction
      // never sees. Generation 0 means "never owned".
      await db
        .insert(generations)
        .values({
          leaseKey: input.leaseKey,
          generation: 0,
          holder: null,
          updatedAt: now,
        })
        .onConflictDoNothing();
      // FOR SHARE: the bump UPDATEs this row, so it must wait for this commit.
      // A plain read would only see this statement's MVCC snapshot and could
      // miss a successor's committed advancement.
      const locked = await db
        .select({ generation: generations.generation })
        .from(generations)
        .where(eq(generations.leaseKey, input.leaseKey))
        .for('share');
      const issued = locked[0]?.generation ?? 0;
      if (leaseGeneration !== issued) {
        const current = await this.getBrowserProfileSnapshotWith(
          db,
          input.profileName,
        );
        return { status: 'stale', current };
      }
    }
    const table = pgSchema.browserProfilesPostgres;

    // Monotonic last-writer-wins guard, ordered lexicographically on
    // (lease generation, fencing version, snapshotted_at).
    //
    // The PROFILE LEASE generation dominates: it is the epoch under which these
    // bytes were produced, so a stale owner loses even when its clock is newer.
    // A lower generation can never win on a fresher snapshotted_at — that is the
    // whole point. Within one generation the pre-existing rule is unchanged (run
    // fencing version, then timestamp), so rows from before this column existed
    // (generation 0 on both sides) behave exactly as they did.
    //
    // `.returning()` yields a row only when the insert or the guarded update
    // actually applied; an empty result means the guard rejected the write.
    // One statement so the guard cannot be raced: INSERT ... SELECT ... WHERE
    // applies `matchesIssuedGeneration` to the INSERT path (no row yet), and the
    // ON CONFLICT guard applies it to the UPDATE path. Guarding only the
    // conflict path would let a stale owner publish the FIRST row.
    const written = await db
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
        snapshotLeaseGeneration: leaseGeneration,
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
          snapshotLeaseGeneration: leaseGeneration,
          snapshottedAt,
          updatedAt: now,
        },
        setWhere: sql`(
          ${leaseGeneration} > ${table.snapshotLeaseGeneration}
          OR (
            ${leaseGeneration} = ${table.snapshotLeaseGeneration}
            AND (
              ${fencingVersion} > ${table.snapshotFencingVersion}
              OR (
                ${fencingVersion} = ${table.snapshotFencingVersion}
                AND ${snapshottedAt} >= ${table.snapshottedAt}
              )
            )
          )
        )`,
      })
      .returning();

    if (written[0]) {
      return { status: 'written', snapshot: toSnapshot(written[0]) };
    }
    // Guard rejected the write: a newer snapshot already exists. Read it back so
    // the caller can report what beat it.
    // `current` is null when the latest-issued guard rejected the write before
    // any row existed (a stale owner writing after its successor acquired the
    // lease but before that successor published), or if the row vanished
    // between the rejected write and this read. Either way the write did not
    // apply, which is what the caller must act on.
    const current = await this.getBrowserProfileSnapshotWith(
      db,
      input.profileName,
    );
    return { status: 'stale', current };
  }
}
