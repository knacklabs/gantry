import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowserProfileSnapshot,
  BrowserProfileSnapshotRepository,
  UpsertBrowserProfileSnapshotInput,
  UpsertBrowserProfileSnapshotResult,
} from '@core/domain/ports/browser-profile-snapshot.js';
import type { RuntimeLeasePort } from '@core/domain/ports/runtime-lease.js';
import { ArtifactIntegrityError } from '@core/domain/ports/browser-profile-artifact-store.js';
import { LocalBrowserProfileArtifactStore } from '@core/adapters/artifacts/browser-profiles/local-browser-profile-artifact-store.js';
import { acquireProfileLock } from '@core/runtime/browser-profiles.js';
import {
  consumeBrowserProfileActivity,
  markBrowserProfileActivity,
  registerBrowserProfileSync,
  restoreBrowserProfile,
  restoreBrowserProfileBeforeLaunch,
  skipNextBrowserProfileSnapshot,
  snapshotBrowserProfile,
} from '@core/runtime/browser-profile-sync.js';

/**
 * In-memory snapshot repo that reproduces the monotonic last-writer-wins guard
 * (the Postgres repo is exercised by the integration test).
 */
class FakeSnapshotRepository implements BrowserProfileSnapshotRepository {
  private rows = new Map<string, BrowserProfileSnapshot>();

  async getBrowserProfileSnapshot(
    profileName: string,
  ): Promise<BrowserProfileSnapshot | null> {
    return this.rows.get(profileName) ?? null;
  }

  async upsertBrowserProfileSnapshot(
    input: UpsertBrowserProfileSnapshotInput,
  ): Promise<UpsertBrowserProfileSnapshotResult> {
    const now = input.now ?? new Date().toISOString();
    const snapshottedAt = input.snapshottedAt ?? now;
    const fence = input.snapshotFencingVersion ?? 0;
    const generation = input.snapshotLeaseGeneration ?? 0;
    const current = this.rows.get(input.profileName);
    // Mirrors the real repository: lexicographic on
    // (lease generation, fencing version, snapshotted_at). A fake that ignored
    // the generation would make every fencing test hollow.
    const monotonic =
      !current ||
      generation > current.snapshotLeaseGeneration ||
      (generation === current.snapshotLeaseGeneration &&
        (fence > current.snapshotFencingVersion ||
          (fence === current.snapshotFencingVersion &&
            snapshottedAt >= current.snapshottedAt)));
    if (!monotonic) return { status: 'stale', current: current! };
    const snapshot: BrowserProfileSnapshot = {
      profileName: input.profileName,
      appId: input.appId ?? null,
      contentHash: input.contentHash,
      storageRef: input.storageRef,
      sizeBytes: input.sizeBytes,
      authMarkers: input.authMarkers ?? [],
      snapshotWorkerInstanceId: input.snapshotWorkerInstanceId ?? null,
      snapshotRunId: input.snapshotRunId ?? null,
      snapshotFencingVersion: fence,
      snapshotLeaseGeneration: generation,
      snapshottedAt,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(input.profileName, snapshot);
    return { status: 'written', snapshot };
  }
}

async function seedUserData(
  userDataDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(userDataDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

function createRuntimeLeasePort(): RuntimeLeasePort {
  const held = new Set<string>();
  return {
    tryAcquire: async (key) => {
      if (held.has(key)) return undefined;
      held.add(key);
      let released = false;
      return {
        generation: 1,
        isValid: () => true,
        release: async () => {
          if (released) return;
          released = true;
          held.delete(key);
        },
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('browser-profile-sync', () => {
  let artifactRoot: string;
  let profileDir: string;
  let userDataDir: string;
  let store: LocalBrowserProfileArtifactStore;
  let repository: FakeSnapshotRepository;
  let leases: RuntimeLeasePort;

  beforeEach(async () => {
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-sync-art-'));
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-sync-prof-'));
    userDataDir = path.join(profileDir, 'user-data');
    store = new LocalBrowserProfileArtifactStore(artifactRoot);
    repository = new FakeSnapshotRepository();
    leases = createRuntimeLeasePort();
  });

  afterEach(async () => {
    registerBrowserProfileSync(null);
    consumeBrowserProfileActivity('p');
    for (const dir of [artifactRoot, profileDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('no-ops when the sync coordinator is unregistered', async () => {
    await seedUserData(userDataDir, { 'Local State': 'x' });
    const result = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(result).toEqual({ status: 'noop', reason: 'sync_disabled' });
  });

  it('no-ops when there is no user-data state', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    const result = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(result).toEqual({ status: 'noop', reason: 'no_state' });
  });

  it('writes a snapshot, then no-ops when the hash is unchanged', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, {
      'Local State': '{}',
      'Default/Cookies': 'c',
    });
    const first = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(first.status).toBe('written');

    const second = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
      snapshotFencingVersion: 2,
    });
    expect(second).toEqual({ status: 'noop', reason: 'unchanged' });
    expect(
      (await repository.getBrowserProfileSnapshot('p'))?.snapshotFencingVersion,
    ).toBe(2);
  });

  it('drops a snapshot at a lower fence than the stored one', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'v2' });
    const high = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
      snapshotFencingVersion: 5,
    });
    expect(high.status).toBe('written');

    // A stale recovered-from worker tries to write different bytes at a lower
    // fence; the monotonic guard rejects it.
    await seedUserData(userDataDir, { 'Local State': 'v1-stale' });
    const stale = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
      snapshotFencingVersion: 3,
    });
    expect(stale.status).toBe('stale');
    expect(
      (await repository.getBrowserProfileSnapshot('p'))?.snapshotFencingVersion,
    ).toBe(5);
  });

  it('skips the snapshot when the profile lock is held (browser relaunched mid-finalize)', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': '{}' });
    // A same-worker concurrent turn relaunched Chrome and holds the profile
    // lock. The snapshot must skip rather than walk a non-quiescent tree or
    // block finalize.
    const held = await acquireProfileLock('lockheld-profile', leases);
    try {
      const result = await snapshotBrowserProfile({
        profileName: 'lockheld-profile',
        profileDir,
        userDataDir,
      });
      expect(result).toEqual({ status: 'noop', reason: 'lock_held' });
      // No artifact was written and no snapshot row was created.
      expect(
        await repository.getBrowserProfileSnapshot('lockheld-profile'),
      ).toBeNull();
    } finally {
      await held.release();
    }

    // Once the lock is free, the same snapshot succeeds.
    const after = await snapshotBrowserProfile({
      profileName: 'lockheld-profile',
      profileDir,
      userDataDir,
    });
    expect(after.status).toBe('written');
  });

  it('takes a SHARED lock so snapshotting does not advance the ownership generation', async () => {
    // If the snapshot bumped the counter it is fenced against, every snapshot
    // would inflate the epoch and a stale owner could end up with a generation
    // newer than the successor that displaced it.
    let issued = 5;
    const counting: RuntimeLeasePort = {
      tryAcquire: async (_key, options) => {
        if (!options?.shared) issued += 1; // ownership advances the epoch
        return {
          generation: issued,
          isValid: () => true,
          release: async () => undefined,
        };
      },
    };
    registerBrowserProfileSync({ store, repository, leases: counting });
    await seedUserData(userDataDir, { 'Local State': 'shared-lock' });

    const result = await snapshotBrowserProfile({
      profileName: 'shared-lock-profile',
      profileDir,
      userDataDir,
      snapshotLeaseGeneration: 5,
    });

    expect(result.status).toBe('written');
    expect(issued).toBe(5);
  });

  it('a stale owner loses to its successor even though it snapshots LAST', async () => {
    // The rule this stage exists for: the fence is the generation carried OUT
    // of the session that produced the bytes. The stale owner snapshots last,
    // so re-reading any shared/profile-wide state (or the snapshot-time lock)
    // would hand it the successor's higher generation and let it clobber.
    const profileName = 'handoff-profile';
    let issued = 10;
    const incrementing: RuntimeLeasePort = {
      tryAcquire: async () => ({
        generation: ++issued,
        isValid: () => true,
        release: async () => undefined,
      }),
    };
    registerBrowserProfileSync({ store, repository, leases: incrementing });

    // Owner A took the profile at generation 1 and starts a slow shutdown; the
    // successor B takes it at generation 2 and publishes FIRST.
    await seedUserData(userDataDir, { 'Local State': 'successor-bytes' });
    const successor = await snapshotBrowserProfile({
      profileName,
      profileDir,
      userDataDir,
      snapshotLeaseGeneration: 2,
    });
    expect(successor.status).toBe('written');
    const afterSuccessor =
      await repository.getBrowserProfileSnapshot(profileName);

    // A finally finishes and snapshots, carrying ITS OWN generation (1).
    await seedUserData(userDataDir, { 'Local State': 'stale-owner-bytes' });
    const stale = await snapshotBrowserProfile({
      profileName,
      profileDir,
      userDataDir,
      snapshotLeaseGeneration: 1,
    });

    expect(stale.status).toBe('stale');
    const finalRow = await repository.getBrowserProfileSnapshot(profileName);
    expect(finalRow?.contentHash).toBe(afterSuccessor?.contentHash);
    expect(finalRow?.snapshotLeaseGeneration).toBe(2);
  });

  it('keeps the loss fence when a newer snapshot attempt does not publish', async () => {
    // The marker is a high-water mark. If a newer generation could clear it
    // merely by ATTEMPTING a snapshot, an attempt that no-ops (or fails on the
    // lock, the upload, or the repository) would unsuppress the dead owner,
    // whose delayed write could then publish.
    const profileName = 'p2-profile';
    registerBrowserProfileSync({ store, repository, leases });
    skipNextBrowserProfileSnapshot(profileName, 1);

    // Newer generation attempts, but there is no state to capture: it returns
    // without ever publishing.
    expect(
      await snapshotBrowserProfile({
        profileName,
        profileDir,
        userDataDir,
        snapshotLeaseGeneration: 2,
      }),
    ).toEqual({ status: 'noop', reason: 'no_state' });

    // The dead generation must STILL be suppressed.
    await seedUserData(userDataDir, { 'Local State': 'stale' });
    expect(
      await snapshotBrowserProfile({
        profileName,
        profileDir,
        userDataDir,
        snapshotLeaseGeneration: 1,
      }),
    ).toEqual({ status: 'noop', reason: 'lease_lost' });
    expect(await repository.getBrowserProfileSnapshot(profileName)).toBeNull();
  });

  it('skips the next snapshot after profile lease ownership is lost', async () => {
    // Dedicated profile name: the marker now PERSISTS for the lost generation
    // (a second stale attempt must stay suppressed), so reusing the shared 'p'
    // here would suppress later tests' snapshots too.
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'unsafe' });
    skipNextBrowserProfileSnapshot('lost-profile', 1);

    const skipped = await snapshotBrowserProfile({
      profileName: 'lost-profile',
      profileDir,
      userDataDir,
    });

    expect(skipped).toEqual({ status: 'noop', reason: 'lease_lost' });
    expect(
      await repository.getBrowserProfileSnapshot('lost-profile'),
    ).toBeNull();

    // Same generation, second attempt: still suppressed (one-shot preserved
    // WITHIN a generation).
    expect(
      await snapshotBrowserProfile({
        profileName: 'lost-profile',
        profileDir,
        userDataDir,
      }),
    ).toEqual({ status: 'noop', reason: 'lease_lost' });

    // A later owner at a HIGHER generation is not suppressed (D-0017).
    expect(
      await snapshotBrowserProfile({
        profileName: 'lost-profile',
        profileDir,
        userDataDir,
        snapshotLeaseGeneration: 2,
      }),
    ).toMatchObject({ status: 'written' });
  });

  it('skips a waiting snapshot when lease loss is marked before its lock is acquired', async () => {
    const acquireStarted = deferred<void>();
    const allowAcquire = deferred<void>();
    const release = vi.fn();
    leases = {
      tryAcquire: async () => {
        acquireStarted.resolve();
        await allowAcquire.promise;
        return { generation: 1, isValid: () => true, release };
      },
    };
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'unsafe' });

    const snapshot = snapshotBrowserProfile({
      profileName: 'waiting-profile',
      profileDir,
      userDataDir,
    });
    await acquireStarted.promise;
    skipNextBrowserProfileSnapshot('waiting-profile', 1);
    allowAcquire.resolve();

    await expect(snapshot).resolves.toEqual({
      status: 'noop',
      reason: 'lease_lost',
    });
    expect(release).toHaveBeenCalledOnce();
    expect(
      await repository.getBrowserProfileSnapshot('waiting-profile'),
    ).toBeNull();
  });

  it('aborts publication when its own snapshot lease becomes invalid', async () => {
    let loseLease!: (err: Error) => void;
    leases = {
      tryAcquire: async () => ({
        generation: 1,
        isValid: () => true,
        release: vi.fn(),
        onLost: (handler) => {
          loseLease = handler;
        },
      }),
    };
    const snapshotRead = deferred<BrowserProfileSnapshot | null>();
    const getSnapshot = vi
      .spyOn(repository, 'getBrowserProfileSnapshot')
      .mockReturnValueOnce(snapshotRead.promise);
    const upsertSnapshot = vi.spyOn(repository, 'upsertBrowserProfileSnapshot');
    const putArtifact = vi.spyOn(store, 'putBrowserProfile');
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'unsafe' });

    const snapshot = snapshotBrowserProfile({
      profileName: 'invalid-profile',
      profileDir,
      userDataDir,
    });
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    loseLease(new Error('database connection lost'));
    snapshotRead.resolve(null);

    await expect(snapshot).rejects.toThrow(
      'Browser profile snapshot lease lost for invalid-profile',
    );
    expect(putArtifact).not.toHaveBeenCalled();
    expect(upsertSnapshot).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(profileDir, 'snapshot.json')),
    ).rejects.toThrow();
  });

  it('restore no-ops with no stored snapshot', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    const result = await restoreBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(result).toEqual({ status: 'noop', reason: 'no_snapshot' });
  });

  it('restore no-ops when the local marker already matches', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'x' });
    await snapshotBrowserProfile({ profileName: 'p', profileDir, userDataDir });
    // snapshot wrote the marker; restore on the same worker is a fast no-op.
    const result = await restoreBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(result).toEqual({ status: 'noop', reason: 'marker_match' });
  });

  it('restores across workers when the stored hash differs from local', async () => {
    // Worker A snapshots.
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, {
      'Local State': 'shared',
      'Default/Cookies': 'session-token',
    });
    await snapshotBrowserProfile({ profileName: 'p', profileDir, userDataDir });

    // Worker B: a fresh profile dir, no local marker, same shared store + repo.
    const profileDirB = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gantry-sync-b-'),
    );
    const userDataDirB = path.join(profileDirB, 'user-data');
    registerBrowserProfileSync({ store, repository, leases });
    const result = await restoreBrowserProfile({
      profileName: 'p',
      profileDir: profileDirB,
      userDataDir: userDataDirB,
    });
    expect(result.status).toBe('restored');
    expect(
      await fs.readFile(path.join(userDataDirB, 'Default/Cookies'), 'utf-8'),
    ).toBe('session-token');
    await fs.rm(profileDirB, { recursive: true, force: true });
  });

  it('fails closed before launch when a stored snapshot cannot be restored', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'shared' });
    await snapshotBrowserProfile({ profileName: 'p', profileDir, userDataDir });

    const brokenStore = {
      putBrowserProfile: store.putBrowserProfile.bind(store),
      materializeBrowserProfile: async () => {
        throw new Error('s3 unavailable');
      },
    };
    const profileDirB = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gantry-sync-b-'),
    );
    registerBrowserProfileSync({ store: brokenStore, repository, leases });
    await expect(
      restoreBrowserProfileBeforeLaunch('p', {
        dir: profileDirB,
        userDataDir: path.join(profileDirB, 'user-data'),
      }),
    ).rejects.toThrow('s3 unavailable');
    await fs.rm(profileDirB, { recursive: true, force: true });
  });

  it('fails open before launch on snapshot integrity error: launches anyway, marker untouched', async () => {
    registerBrowserProfileSync({ store, repository, leases });
    await seedUserData(userDataDir, { 'Local State': 'shared' });
    await snapshotBrowserProfile({ profileName: 'p', profileDir, userDataDir });

    // A corrupt snapshot object is the same content-addressed ref on every
    // worker; failing closed would brick launch fleet-wide. The store already
    // quarantines the bad object, so the launch path must proceed with local
    // state and NOT advance the local marker (so a later good snapshot still
    // restores).
    const quarantiningStore = {
      putBrowserProfile: store.putBrowserProfile.bind(store),
      materializeBrowserProfile: async () => {
        throw new ArtifactIntegrityError({
          storageRef: 'browser-profiles/p/corrupt',
          expectedContentHash: `sha256:${'a'.repeat(64)}`,
          actualContentHash: `sha256:${'b'.repeat(64)}`,
          quarantinePath: '/tmp/quarantine/corrupt',
        });
      },
    };
    const profileDirB = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gantry-sync-b-'),
    );
    registerBrowserProfileSync({
      store: quarantiningStore,
      repository,
      leases,
    });

    // Fails OPEN: no throw, launch proceeds.
    await expect(
      restoreBrowserProfileBeforeLaunch('p', {
        dir: profileDirB,
        userDataDir: path.join(profileDirB, 'user-data'),
      }),
    ).resolves.toBeUndefined();

    // The local marker was never written, so a later good snapshot restore is
    // still attempted on this worker.
    await expect(
      fs.access(path.join(profileDirB, 'snapshot.json')),
    ).rejects.toThrow();
    await fs.rm(profileDirB, { recursive: true, force: true });
  });

  it('tracks and consumes the per-profile activity flag', () => {
    expect(consumeBrowserProfileActivity('p')).toBe(false);
    markBrowserProfileActivity('p');
    expect(consumeBrowserProfileActivity('p')).toBe(true);
    // Consume is read-and-clear.
    expect(consumeBrowserProfileActivity('p')).toBe(false);
  });
});
