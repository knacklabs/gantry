import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  BrowserProfileSnapshot,
  BrowserProfileSnapshotRepository,
  UpsertBrowserProfileSnapshotInput,
  UpsertBrowserProfileSnapshotResult,
} from '@core/domain/ports/browser-profile-snapshot.js';
import { ArtifactIntegrityError } from '@core/domain/ports/browser-profile-artifact-store.js';
import { LocalBrowserProfileArtifactStore } from '@core/adapters/artifacts/browser-profiles/local-browser-profile-artifact-store.js';
import { acquireProfileLock } from '@core/runtime/browser-profiles.js';
import {
  consumeBrowserProfileActivity,
  markBrowserProfileActivity,
  registerBrowserProfileSync,
  restoreBrowserProfile,
  restoreBrowserProfileBeforeLaunch,
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
    const current = this.rows.get(input.profileName);
    const monotonic =
      !current ||
      fence > current.snapshotFencingVersion ||
      (fence === current.snapshotFencingVersion &&
        snapshottedAt >= current.snapshottedAt);
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

describe('browser-profile-sync', () => {
  let artifactRoot: string;
  let profileDir: string;
  let userDataDir: string;
  let store: LocalBrowserProfileArtifactStore;
  let repository: FakeSnapshotRepository;

  beforeEach(async () => {
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-sync-art-'));
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-sync-prof-'));
    userDataDir = path.join(profileDir, 'user-data');
    store = new LocalBrowserProfileArtifactStore(artifactRoot);
    repository = new FakeSnapshotRepository();
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
    registerBrowserProfileSync({ store, repository });
    const result = await snapshotBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(result).toEqual({ status: 'noop', reason: 'no_state' });
  });

  it('writes a snapshot, then no-ops when the hash is unchanged', async () => {
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store, repository });
    await seedUserData(userDataDir, { 'Local State': '{}' });
    // A same-worker concurrent turn relaunched Chrome and holds the profile
    // lock. The snapshot must skip rather than walk a non-quiescent tree or
    // block finalize.
    const held = await acquireProfileLock('lockheld-profile');
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
      held.release();
    }

    // Once the lock is free, the same snapshot succeeds.
    const after = await snapshotBrowserProfile({
      profileName: 'lockheld-profile',
      profileDir,
      userDataDir,
    });
    expect(after.status).toBe('written');
  });

  it('restore no-ops with no stored snapshot', async () => {
    registerBrowserProfileSync({ store, repository });
    const result = await restoreBrowserProfile({
      profileName: 'p',
      profileDir,
      userDataDir,
    });
    expect(result).toEqual({ status: 'noop', reason: 'no_snapshot' });
  });

  it('restore no-ops when the local marker already matches', async () => {
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store: brokenStore, repository });
    await expect(
      restoreBrowserProfileBeforeLaunch('p', {
        dir: profileDirB,
        userDataDir: path.join(profileDirB, 'user-data'),
      }),
    ).rejects.toThrow('s3 unavailable');
    await fs.rm(profileDirB, { recursive: true, force: true });
  });

  it('fails open before launch on snapshot integrity error: launches anyway, marker untouched', async () => {
    registerBrowserProfileSync({ store, repository });
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
    registerBrowserProfileSync({ store: quarantiningStore, repository });

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
