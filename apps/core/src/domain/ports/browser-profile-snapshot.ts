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
  snapshottedAt?: string;
  now?: string;
}

export type UpsertBrowserProfileSnapshotResult =
  | { status: 'written'; snapshot: BrowserProfileSnapshot }
  | {
      /**
       * The monotonic last-writer-wins guard rejected the write: an existing row
       * for this profile has a fencing version higher than the incoming one, or
       * an equal fencing version with a snapshotted_at that is newer. The stale
       * writer (e.g. a recovered-from worker whose lease was reclaimed at a
       * higher fence) must drop its snapshot.
       */
      status: 'stale';
      current: BrowserProfileSnapshot;
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
   * Monotonic last-writer-wins upsert keyed on (snapshotFencingVersion,
   * snapshottedAt): the write applies only when the incoming pair is not older
   * than the stored row. Returns `stale` (without mutating) when a newer
   * snapshot already exists.
   */
  upsertBrowserProfileSnapshot(
    input: UpsertBrowserProfileSnapshotInput,
  ): Promise<UpsertBrowserProfileSnapshotResult>;
}
