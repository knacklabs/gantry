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

/**
 * Rows reach this mapper from two places with different runtimes shapes: the
 * Drizzle query (numbers, ISO strings) and the raw `db.execute` upsert, where
 * node-postgres hands back bigints as STRINGS and timestamptz as Date objects.
 * Normalize both rather than trusting the static type.
 */
function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? '');
  // Raw pg renders timestamptz in Postgres text format ('2026-06-13 01:00:00+00');
  // the Drizzle read path yields ISO-8601. Normalize so a caller cannot observe
  // two different formats for the same column depending on which path produced
  // the row.
  if (!text || text.includes('T')) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function toSnapshot(row: BrowserProfileRow): BrowserProfileSnapshot {
  return {
    profileName: row.profileName,
    appId: row.appId ?? null,
    contentHash: row.contentHash,
    storageRef: row.storageRef,
    sizeBytes: asNumber(row.sizeBytes),
    authMarkers: Array.isArray(row.authMarkersJson)
      ? (row.authMarkersJson as string[])
      : [],
    snapshotWorkerInstanceId: row.snapshotWorkerInstanceId ?? null,
    snapshotRunId: row.snapshotRunId ?? null,
    snapshotFencingVersion: asNumber(row.snapshotFencingVersion),
    snapshotLeaseGeneration: asNumber(row.snapshotLeaseGeneration),
    snapshottedAt: asIsoString(row.snapshottedAt),
    createdAt: asIsoString(row.createdAt),
    updatedAt: asIsoString(row.updatedAt),
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
      // Ensure a row exists so there is something to lock: without it a
      // concurrent first-ever acquisition could INSERT one that this
      // transaction never sees. Generation 0 means "never owned".
      await db.execute(sql`
        INSERT INTO runtime_lease_generations (lease_key, generation, holder, updated_at)
        VALUES (${input.leaseKey}, 0, NULL, now())
        ON CONFLICT (lease_key) DO NOTHING
      `);
      const locked = await db.execute(sql`
        SELECT generation FROM runtime_lease_generations
        WHERE lease_key = ${input.leaseKey}
        FOR SHARE
      `);
      const issued = asNumber(
        (locked as unknown as { rows: Array<{ generation: unknown }> }).rows[0]
          ?.generation,
      );
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
    const inserted = await db.execute(sql`
      INSERT INTO ${table} (
        profile_name, app_id, content_hash, storage_ref, size_bytes,
        auth_markers_json, snapshot_worker_instance_id, snapshot_run_id,
        snapshot_fencing_version, snapshot_lease_generation,
        snapshotted_at, created_at, updated_at
      )
      SELECT
        ${input.profileName}, ${input.appId ?? null}, ${input.contentHash},
        ${input.storageRef}, ${input.sizeBytes},
        ${JSON.stringify(input.authMarkers ?? [])}::jsonb,
        ${input.snapshotWorkerInstanceId ?? null}, ${input.snapshotRunId ?? null},
        ${fencingVersion}, ${leaseGeneration},
        ${snapshottedAt}::timestamptz, ${now}::timestamptz, ${now}::timestamptz
      ON CONFLICT (profile_name) DO UPDATE SET
        app_id = EXCLUDED.app_id,
        content_hash = EXCLUDED.content_hash,
        storage_ref = EXCLUDED.storage_ref,
        size_bytes = EXCLUDED.size_bytes,
        auth_markers_json = EXCLUDED.auth_markers_json,
        snapshot_worker_instance_id = EXCLUDED.snapshot_worker_instance_id,
        snapshot_run_id = EXCLUDED.snapshot_run_id,
        snapshot_fencing_version = EXCLUDED.snapshot_fencing_version,
        snapshot_lease_generation = EXCLUDED.snapshot_lease_generation,
        snapshotted_at = EXCLUDED.snapshotted_at,
        updated_at = EXCLUDED.updated_at
      WHERE (
        ${leaseGeneration} > ${table.snapshotLeaseGeneration}
        OR (
          ${leaseGeneration} = ${table.snapshotLeaseGeneration}
          AND (
            ${fencingVersion} > ${table.snapshotFencingVersion}
            OR (
              ${fencingVersion} = ${table.snapshotFencingVersion}
              AND ${snapshottedAt}::timestamptz >= ${table.snapshottedAt}
            )
          )
        )
      )
      RETURNING
        profile_name AS "profileName",
        app_id AS "appId",
        content_hash AS "contentHash",
        storage_ref AS "storageRef",
        size_bytes AS "sizeBytes",
        auth_markers_json AS "authMarkersJson",
        snapshot_worker_instance_id AS "snapshotWorkerInstanceId",
        snapshot_run_id AS "snapshotRunId",
        snapshot_fencing_version AS "snapshotFencingVersion",
        snapshot_lease_generation AS "snapshotLeaseGeneration",
        snapshotted_at AS "snapshottedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `);
    // db.execute() returns RAW node-postgres rows: they carry whatever names the
    // RETURNING clause produced, with no Drizzle mapping. The aliases above are
    // what make this shape match BrowserProfileRow — without them every field
    // would arrive snake_cased and read back undefined.
    const written = (inserted as unknown as { rows: BrowserProfileRow[] }).rows;

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
