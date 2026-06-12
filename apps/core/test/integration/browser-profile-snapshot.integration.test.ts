import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresBrowserProfileSnapshotRepository } from '@core/adapters/storage/postgres/repositories/browser-profile-snapshot-repository.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import type { BrowserProfileSnapshotRepository } from '@core/domain/ports/browser-profile-snapshot.js';
import { LocalBrowserProfileArtifactStore } from '@core/adapters/artifacts/browser-profiles/local-browser-profile-artifact-store.js';
import {
  registerBrowserProfileSync,
  restoreBrowserProfile,
  snapshotBrowserProfile,
} from '@core/runtime/browser-profile-sync.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('Browser profile snapshot store (0079)', () => {
  let service: PostgresStorageService;
  let repositories: PostgresDomainRepositoryBundle;
  let browserProfileSnapshots: BrowserProfileSnapshotRepository;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `bp_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    // Applying migrations through 0079 proves the migration applies cleanly.
    await service.migrate();
    repositories = createPostgresDomainRepositories(service.db, service.pool);
    browserProfileSnapshots = new PostgresBrowserProfileSnapshotRepository(
      service.db,
    );
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
    );
    await service.close();
  });

  afterEach(() => registerBrowserProfileSync(null));

  describe('repository monotonic guard', () => {
    it('round-trips and rejects a stale fenced upsert after a higher one lands', async () => {
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-roundtrip';

      const first = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: `sha256:${'a'.repeat(64)}`,
        storageRef: `browser-profiles/${profileName}/${'a'.repeat(64)}`,
        sizeBytes: 10,
        authMarkers: ['cookies'],
        snapshotWorkerInstanceId: 'worker-A',
        snapshotFencingVersion: 2,
        snapshottedAt: '2026-06-11T00:00:00.000Z',
        now: '2026-06-11T00:00:00.000Z',
      });
      expect(first.status).toBe('written');

      const read = await repo.getBrowserProfileSnapshot(profileName);
      expect(read?.contentHash).toBe(`sha256:${'a'.repeat(64)}`);
      expect(read?.snapshotFencingVersion).toBe(2);
      expect(read?.authMarkers).toEqual(['cookies']);

      // A higher fence wins.
      const higher = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: `sha256:${'b'.repeat(64)}`,
        storageRef: `browser-profiles/${profileName}/${'b'.repeat(64)}`,
        sizeBytes: 20,
        snapshotWorkerInstanceId: 'worker-B',
        snapshotFencingVersion: 4,
        snapshottedAt: '2026-06-11T00:01:00.000Z',
        now: '2026-06-11T00:01:00.000Z',
      });
      expect(higher.status).toBe('written');

      // A stale lower fence is rejected and does NOT mutate the row.
      const stale = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: `sha256:${'c'.repeat(64)}`,
        storageRef: `browser-profiles/${profileName}/${'c'.repeat(64)}`,
        sizeBytes: 30,
        snapshotWorkerInstanceId: 'worker-A-recovered-from',
        snapshotFencingVersion: 3,
        snapshottedAt: '2026-06-11T00:02:00.000Z',
        now: '2026-06-11T00:02:00.000Z',
      });
      expect(stale.status).toBe('stale');
      if (stale.status === 'stale') {
        expect(stale.current.snapshotFencingVersion).toBe(4);
        expect(stale.current.contentHash).toBe(`sha256:${'b'.repeat(64)}`);
      }

      const final = await repo.getBrowserProfileSnapshot(profileName);
      expect(final?.snapshotFencingVersion).toBe(4);
      expect(final?.contentHash).toBe(`sha256:${'b'.repeat(64)}`);
    });

    it('accepts an equal fence with a not-older timestamp', async () => {
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-equalfence';
      await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: `sha256:${'1'.repeat(64)}`,
        storageRef: `browser-profiles/${profileName}/${'1'.repeat(64)}`,
        sizeBytes: 1,
        snapshotFencingVersion: 7,
        snapshottedAt: '2026-06-11T00:00:00.000Z',
        now: '2026-06-11T00:00:00.000Z',
      });
      const equal = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: `sha256:${'2'.repeat(64)}`,
        storageRef: `browser-profiles/${profileName}/${'2'.repeat(64)}`,
        sizeBytes: 2,
        snapshotFencingVersion: 7,
        snapshottedAt: '2026-06-11T00:05:00.000Z',
        now: '2026-06-11T00:05:00.000Z',
      });
      expect(equal.status).toBe('written');
      expect(
        (await repo.getBrowserProfileSnapshot(profileName))?.contentHash,
      ).toBe(`sha256:${'2'.repeat(64)}`);
    });
  });

  describe('snapshot → restore across two simulated workers', () => {
    it('worker A snapshots; worker B restores the same bytes', async () => {
      const artifactRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gantry-bp-int-art-'),
      );
      const profileDirA = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gantry-bp-int-a-'),
      );
      const profileDirB = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gantry-bp-int-b-'),
      );
      const store = new LocalBrowserProfileArtifactStore(artifactRoot);
      const profileName = 'c-kai-twoworker';
      try {
        // Worker A: fabricate a user-data tree and snapshot it.
        const userDataA = path.join(profileDirA, 'user-data');
        await fs.mkdir(path.join(userDataA, 'Default'), { recursive: true });
        await fs.writeFile(path.join(userDataA, 'Local State'), '{"v":1}');
        await fs.writeFile(
          path.join(userDataA, 'Default/Cookies'),
          'session-token',
        );
        // A cache file that must NOT travel with the snapshot.
        await fs.mkdir(path.join(userDataA, 'Default/Cache'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(userDataA, 'Default/Cache/data_0'),
          'junk',
        );

        registerBrowserProfileSync({
          store,
          repository: browserProfileSnapshots,
          workerInstanceId: 'worker-A',
        });
        const snap = await snapshotBrowserProfile({
          profileName,
          profileDir: profileDirA,
          userDataDir: userDataA,
          snapshotFencingVersion: 1,
        });
        expect(snap.status).toBe('written');

        // Worker B: fresh profile dir, no local state; restore from the store.
        const userDataB = path.join(profileDirB, 'user-data');
        registerBrowserProfileSync({
          store,
          repository: browserProfileSnapshots,
          workerInstanceId: 'worker-B',
        });
        const restore = await restoreBrowserProfile({
          profileName,
          profileDir: profileDirB,
          userDataDir: userDataB,
        });
        expect(restore.status).toBe('restored');
        expect(
          await fs.readFile(path.join(userDataB, 'Default/Cookies'), 'utf-8'),
        ).toBe('session-token');
        expect(
          await fs.readFile(path.join(userDataB, 'Local State'), 'utf-8'),
        ).toBe('{"v":1}');
        // The cache was excluded from the snapshot, so it is absent after restore.
        await expect(
          fs.access(path.join(userDataB, 'Default/Cache/data_0')),
        ).rejects.toThrow();
      } finally {
        for (const dir of [artifactRoot, profileDirA, profileDirB]) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
    });
  });
});
