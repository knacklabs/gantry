import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  BrowserProfileArtifactFile,
  BrowserProfileArtifactMaterializer,
  BrowserProfileArtifactStore,
} from '../domain/ports/browser-profile-artifact-store.js';
import { ArtifactIntegrityError } from '../domain/ports/browser-profile-artifact-store.js';
import type {
  BrowserProfileSnapshotRepository,
  UpsertBrowserProfileSnapshotResult,
} from '../domain/ports/browser-profile-snapshot.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isExcludedBrowserProfilePath } from '../shared/browser-profile-snapshot-exclude.js';
import { hashBrowserProfileFileModel } from '../shared/browser-profile-hash.js';
import { nowIso } from '../shared/time/datetime.js';
import { acquireProfileLock } from './browser-profiles.js';

/**
 * Snapshot quiescence acquire window. Finalize already closed the browser and
 * released its lock, so the lock is normally free. A short timeout means: if a
 * same-worker concurrent turn relaunched Chrome and is holding the lock, give up
 * fast and SKIP the snapshot rather than blocking finalize. The walked bytes
 * would be torn (Chrome live again) and a verified hash over a torn tree would
 * be silently wrong, so skipping is the only safe choice.
 */
const SNAPSHOT_LOCK_TIMEOUT_MS = 250;

/**
 * Cross-worker browser profile snapshot/restore coordinator. Holds the injected
 * artifact store + snapshot repository (constructed in the adapters storage
 * factory) so the runtime browser-capability module never imports adapters. A
 * worker registers exactly one coordinator at startup via
 * {@link registerBrowserProfileSync}; the workstation single-process path simply
 * never registers one, so snapshot/restore become no-ops with zero overhead.
 */
export interface BrowserProfileSyncDeps {
  store: BrowserProfileArtifactStore & BrowserProfileArtifactMaterializer;
  repository: BrowserProfileSnapshotRepository;
  workerInstanceId?: string;
}

export interface SnapshotProfileInput {
  profileName: string;
  /** Profile directory root (`<root>/<name>`); `user-data/` lives inside it. */
  profileDir: string;
  userDataDir: string;
  appId?: string | null;
  snapshotRunId?: string | null;
  /** Lease fence of the snapshotting turn; higher == more recent ownership. */
  snapshotFencingVersion?: number;
  authMarkers?: string[];
}

export interface RestoreProfileInput {
  profileName: string;
  profileDir: string;
  userDataDir: string;
}

const SNAPSHOT_MARKER_FILE = 'snapshot.json';

let coordinator: BrowserProfileSyncDeps | null = null;

/**
 * Per-profile "the browser was actually used this turn" flag. Set by the IPC
 * browser handler when it processes a browser action; consumed (read + cleared)
 * by the live finalize snapshot trigger. In-memory and bounded by the number of
 * distinct profile names a worker touches between finalizes; cleared on consume.
 * The JOB path uses its own browserActivityCount diagnostic instead.
 */
const profileActivity = new Set<string>();

export function markBrowserProfileActivity(profileName: string): void {
  profileActivity.add(profileName);
}

/** Read-and-clear the activity flag for a profile. */
export function consumeBrowserProfileActivity(profileName: string): boolean {
  return profileActivity.delete(profileName);
}

export function registerBrowserProfileSync(
  deps: BrowserProfileSyncDeps | null,
): void {
  coordinator = deps;
}

export function isBrowserProfileSyncEnabled(): boolean {
  return coordinator !== null;
}

export async function browserProfileNeedsRestore(
  profileName: string,
  profileDir: string,
): Promise<boolean> {
  if (!coordinator) return false;
  const snapshot =
    await coordinator.repository.getBrowserProfileSnapshot(profileName);
  if (!snapshot) return false;
  const marker = readSnapshotMarker(profileDir);
  return marker?.content_hash !== snapshot.contentHash;
}

interface SnapshotMarker {
  content_hash: string;
}

function markerPath(profileDir: string): string {
  return path.join(profileDir, SNAPSHOT_MARKER_FILE);
}

function readSnapshotMarker(profileDir: string): SnapshotMarker | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(markerPath(profileDir), 'utf-8'),
    ) as Record<string, unknown> | null;
    if (parsed && typeof parsed.content_hash === 'string') {
      return { content_hash: parsed.content_hash };
    }
  } catch {
    // Missing or malformed marker ⇒ treat as no local snapshot.
  }
  return null;
}

function writeSnapshotMarker(profileDir: string, contentHash: string): void {
  const target = markerPath(profileDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ content_hash: contentHash }));
  fs.renameSync(tmp, target);
}

/**
 * Walk the live `user-data/` tree into the artifact file model, dropping caches
 * and host-local junk per {@link isExcludedBrowserProfilePath}. Preserves modes
 * + relative symlinks. Returns `null` when the tree is empty (nothing to
 * snapshot).
 */
export async function collectUserDataFiles(
  userDataDir: string,
): Promise<BrowserProfileArtifactFile[] | null> {
  const rootPath = path.resolve(userDataDir);
  let rootStat: fs.Stats;
  try {
    rootStat = await fsp.stat(rootPath);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const files: BrowserProfileArtifactFile[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      const relative = path
        .relative(rootPath, entryPath)
        .split(path.sep)
        .join('/');
      if (isExcludedBrowserProfilePath(relative)) continue;
      if (entry.isSymbolicLink()) {
        const linkTarget = await fsp.readlink(entryPath);
        // Only relative, in-tree symlinks are snapshot-safe. Skip anything that
        // escapes the user-data root rather than fail the whole snapshot.
        if (
          !linkTarget ||
          linkTarget.includes('\0') ||
          path.posix.isAbsolute(linkTarget) ||
          /^[A-Za-z]:\//.test(linkTarget)
        ) {
          continue;
        }
        const resolved = path.resolve(path.dirname(entryPath), linkTarget);
        if (
          resolved !== rootPath &&
          !resolved.startsWith(`${rootPath}${path.sep}`)
        ) {
          continue;
        }
        files.push({
          path: relative,
          kind: 'symlink',
          linkTarget,
          content: Buffer.alloc(0),
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(entryPath);
      files.push({
        path: relative,
        kind: 'file',
        mode: stat.mode & 0o777,
        content: await fsp.readFile(entryPath),
      });
    }
  }

  await visit(rootPath);
  return files.length > 0 ? files : null;
}

/**
 * Snapshot a profile after its browser was closed (bytes quiescent). Cheap
 * no-ops when: no coordinator registered, the user-data tree is empty, or the
 * content hash already matches the stored snapshot for this profile.
 *
 * Quiescence is enforced by holding the FS profile lock across the whole bundle
 * read + hash + upload. Finalize already closed the browser (releasing its
 * lock), so the lock is normally free here. But a same-worker concurrent turn
 * could relaunch Chrome between close and snapshot; if it holds the lock we SKIP
 * (status `noop`, reason `lock_held`) rather than walk a tree Chrome is actively
 * mutating — a verified hash over a torn bundle would be silently wrong. We
 * never block finalize: the acquire timeout is short and a lost race just skips.
 */
export async function snapshotBrowserProfile(
  input: SnapshotProfileInput,
): Promise<
  | { status: 'noop'; reason: string }
  | { status: 'written'; contentHash: string }
  | { status: 'stale'; contentHash: string }
> {
  if (!coordinator) return { status: 'noop', reason: 'sync_disabled' };

  let lock: { release: () => void };
  try {
    lock = await acquireProfileLock(
      input.profileName,
      SNAPSHOT_LOCK_TIMEOUT_MS,
    );
  } catch {
    // Lock held by a live Chrome relaunch (or contended). Skip rather than
    // block finalize or snapshot a non-quiescent tree.
    logger.info(
      { profileName: input.profileName },
      'Skipped browser profile snapshot: profile lock held (browser relaunched mid-finalize)',
    );
    return { status: 'noop', reason: 'lock_held' };
  }

  try {
    const files = await collectUserDataFiles(input.userDataDir);
    if (!files) return { status: 'noop', reason: 'no_state' };
    const contentHash = hashBrowserProfileFileModel(files);

    const existing = await coordinator.repository.getBrowserProfileSnapshot(
      input.profileName,
    );
    if (existing && existing.contentHash === contentHash) {
      const result = await coordinator.repository.upsertBrowserProfileSnapshot({
        profileName: input.profileName,
        appId: input.appId ?? existing.appId,
        contentHash: existing.contentHash,
        storageRef: existing.storageRef,
        sizeBytes: existing.sizeBytes,
        authMarkers: input.authMarkers ?? existing.authMarkers,
        snapshotWorkerInstanceId: coordinator.workerInstanceId ?? null,
        snapshotRunId: input.snapshotRunId ?? null,
        snapshotFencingVersion: input.snapshotFencingVersion ?? 0,
        snapshottedAt: nowIso(),
      });
      if (result.status === 'stale') {
        logger.warn(
          {
            profileName: input.profileName,
            incomingFence: input.snapshotFencingVersion ?? 0,
            currentFence: result.current.snapshotFencingVersion,
          },
          'Dropped stale browser profile snapshot metadata update',
        );
        return { status: 'stale', contentHash };
      }
      // Bytes unchanged since the last snapshot: write no artifact bytes, but
      // advance the fencing metadata and keep the local marker in sync.
      writeSnapshotMarker(input.profileDir, contentHash);
      return { status: 'noop', reason: 'unchanged' };
    }

    const stored = await coordinator.store.putBrowserProfile({
      profileName: input.profileName,
      files,
    });
    const result: UpsertBrowserProfileSnapshotResult =
      await coordinator.repository.upsertBrowserProfileSnapshot({
        profileName: input.profileName,
        appId: input.appId ?? null,
        contentHash: stored.contentHash,
        storageRef: stored.storageRef,
        sizeBytes: stored.sizeBytes,
        authMarkers: input.authMarkers ?? [],
        snapshotWorkerInstanceId: coordinator.workerInstanceId ?? null,
        snapshotRunId: input.snapshotRunId ?? null,
        snapshotFencingVersion: input.snapshotFencingVersion ?? 0,
        snapshottedAt: nowIso(),
      });

    if (result.status === 'stale') {
      logger.warn(
        {
          profileName: input.profileName,
          incomingFence: input.snapshotFencingVersion ?? 0,
          currentFence: result.current.snapshotFencingVersion,
        },
        'Dropped stale browser profile snapshot (a newer snapshot already exists)',
      );
      return { status: 'stale', contentHash: stored.contentHash };
    }
    writeSnapshotMarker(input.profileDir, stored.contentHash);
    return { status: 'written', contentHash: stored.contentHash };
  } finally {
    lock.release();
  }
}

/**
 * Restore wrapper for the Chrome launch path. Skips fast when sync is disabled
 * or no snapshot exists.
 *
 * A genuine restore FAILURE (store unreachable, IO error) fails closed: stale
 * local state could overwrite the newer shared profile at turn finalization, so
 * we surface the error and block launch.
 *
 * An INTEGRITY error is different and fails OPEN. The bad snapshot object is the
 * same content-addressed ref on every worker, so failing closed would brick
 * launch for that profile fleet-wide with no self-healing. The store has already
 * quarantined the corrupt object; we log loudly and proceed with the local
 * profile (possibly stale; worst case the agent re-auths). The local marker is
 * intentionally NOT advanced on this path so a later good snapshot still
 * restores.
 */
export async function restoreBrowserProfileBeforeLaunch(
  profileName: string,
  profile: { dir: string; userDataDir: string },
): Promise<void> {
  if (!coordinator) return;
  try {
    const result = await restoreBrowserProfile({
      profileName,
      profileDir: profile.dir,
      userDataDir: profile.userDataDir,
    });
    if (result.status === 'integrity_error') {
      logger.error(
        { profileName, quarantinePath: result.quarantinePath },
        'Browser profile snapshot failed integrity validation; quarantined the corrupt object and launching from local profile to preserve availability',
      );
    }
  } catch (err) {
    logger.error(
      { err, profileName },
      'Failed to restore browser profile snapshot before launch',
    );
    throw err;
  }
}

/**
 * Restore a profile before Chrome launch. No-ops when: no coordinator, no stored
 * snapshot, or the local marker already matches the stored content hash
 * (same-worker fast path). Materializes atomically (temp dir + verify + swap)
 * and quarantines on integrity mismatch.
 *
 * The caller MUST guarantee no owned Chrome is running against this user-data
 * dir (the launch path calls this only after the persisted-session adoption
 * check returns null).
 */
export async function restoreBrowserProfile(
  input: RestoreProfileInput,
): Promise<
  | { status: 'noop'; reason: string }
  | { status: 'restored'; contentHash: string }
  | { status: 'integrity_error'; quarantinePath: string }
> {
  if (!coordinator) return { status: 'noop', reason: 'sync_disabled' };
  const snapshot = await coordinator.repository.getBrowserProfileSnapshot(
    input.profileName,
  );
  if (!snapshot) return { status: 'noop', reason: 'no_snapshot' };

  const marker = readSnapshotMarker(input.profileDir);
  if (marker && marker.content_hash === snapshot.contentHash) {
    return { status: 'noop', reason: 'marker_match' };
  }

  const quarantineDir = path.join(input.profileDir, 'quarantine');
  try {
    const materialized = await coordinator.store.materializeBrowserProfile({
      storageRef: snapshot.storageRef,
      expectedContentHash: snapshot.contentHash,
      targetDir: input.userDataDir,
      quarantineDir,
    });
    writeSnapshotMarker(input.profileDir, materialized.contentHash);
    logger.info(
      { profileName: input.profileName, contentHash: materialized.contentHash },
      'Restored browser profile snapshot before launch',
    );
    return { status: 'restored', contentHash: materialized.contentHash };
  } catch (err) {
    if (err instanceof ArtifactIntegrityError) {
      logger.warn(
        {
          profileName: input.profileName,
          storageRef: snapshot.storageRef,
          quarantinePath: err.quarantinePath,
        },
        'Browser profile snapshot failed integrity check; quarantined, launching from local state',
      );
      return { status: 'integrity_error', quarantinePath: err.quarantinePath };
    }
    throw err;
  }
}
