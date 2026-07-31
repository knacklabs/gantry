export interface BrowserProfileSnapshot {
  profileName: string;
  appId: string | null;
  contentHash: string;
  storageRef: string;
  sizeBytes: number;
  authMarkers: string[];
  snapshotWorkerInstanceId: string | null;
  snapshotRunId: string | null;
  snapshotFencingVersion: number;
  /**
   * Ownership generation of the PROFILE LEASE under which these bytes were
   * produced. Dominant fence: see UpsertBrowserProfileSnapshotInput.
   */
  snapshotLeaseGeneration: number;
  snapshottedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertBrowserProfileSnapshotInput {
  profileName: string;
  appId?: string | null;
  contentHash: string;
  storageRef: string;
  sizeBytes: number;
  authMarkers?: string[];
  snapshotWorkerInstanceId?: string | null;
  snapshotRunId?: string | null;
  /**
   * Lease fencing version of the snapshotting turn. Higher == more recent
   * ownership (a recovered run runs at a strictly higher fence). Default 0 for
   * the workstation single-process path that has no lease fence.
   */
  snapshotFencingVersion?: number;
  /**
   * Ownership generation of the profile lease held when the snapshotted bytes
   * were produced (issued by runtime_lease_generations, see
   * `RuntimeLease.generation`). This is the DOMINANT fence — a lower generation
   * loses even with a newer `snapshottedAt`, which is how a stale owner whose
   * Chrome kept writing after handoff is rejected.
   *
   * Must be the generation captured when profile ownership BEGAN (restore,
   * before launch), never one acquired at snapshot time: a stale owner taking a
   * fresh lock at snapshot time would get a HIGHER generation and win.
   *
   * Defaults to 0 for callers with no profile lease; rows written before this
   * existed also read as 0, so the first real generation supersedes them.
   */
  snapshotLeaseGeneration?: number;
  /**
   * Lease key whose LATEST ISSUED generation this write must not be older than
   * (e.g. `browser-profile:<name>`). Without it the guard can only compare
   * against the stored row, which lets a stale owner win whenever the row is
   * behind — A owns generation 1, releases, B acquires 2 and starts, and A's
   * delayed write lands while the row is still 0.
   */
  leaseKey?: string;
  snapshottedAt?: string;
  now?: string;
}

export type UpsertBrowserProfileSnapshotResult =
  | { status: 'written'; snapshot: BrowserProfileSnapshot }
  | {
      /**
       * The monotonic last-writer-wins guard rejected the write. Ordering is
       * lexicographic on (lease generation, fencing version, snapshotted_at):
       * an existing row wins on a higher profile-lease generation, or an equal
       * generation with a higher fencing version, or an equal pair with a newer
       * snapshotted_at. The stale writer (a previous profile-lease generation,
       * or a recovered-from worker at a lower run fence) must drop its
       * snapshot.
       */
      status: 'stale';
      /**
       * The row that beat this write, or `null` when the write was rejected by
       * the latest-issued-generation guard before any row existed — a stale
       * owner writing after a successor acquired the lease but before it
       * published.
       */
      current: BrowserProfileSnapshot | null;
    };

/**
 * Durable index over cross-worker browser profile snapshots. The bytes live in
 * the BrowserProfileArtifactStore; this records the current content hash +
 * storage ref so a worker admitting the same conversation elsewhere can decide
 * whether to restore.
 */
export interface BrowserProfileSnapshotRepository {
  getBrowserProfileSnapshot(
    profileName: string,
  ): Promise<BrowserProfileSnapshot | null>;
  /**
   * Monotonic last-writer-wins upsert ordered on (snapshotLeaseGeneration,
   * snapshotFencingVersion, snapshottedAt): the write applies only when the
   * incoming triple is not older than the stored row. Returns `stale` (without
   * mutating) when a newer snapshot already exists.
   */
  upsertBrowserProfileSnapshot(
    input: UpsertBrowserProfileSnapshotInput,
  ): Promise<UpsertBrowserProfileSnapshotResult>;
}
