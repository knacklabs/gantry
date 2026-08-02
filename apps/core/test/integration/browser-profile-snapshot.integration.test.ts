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
const leases = {
  tryAcquire: async () => ({
    generation: 1,
    isValid: () => true,
    release: async () => {},
  }),
};

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

  describe('profile-lease generation fence (FENCE-1-b)', () => {
    const hash = (c: string) => `sha256:${c.repeat(64)}`;
    const write = (
      repo: BrowserProfileSnapshotRepository,
      profileName: string,
      c: string,
      fields: {
        snapshotLeaseGeneration?: number;
        snapshotFencingVersion?: number;
        snapshottedAt: string;
      },
    ) =>
      repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: hash(c),
        storageRef: `browser-profiles/${profileName}/${c.repeat(64)}`,
        sizeBytes: 1,
        now: fields.snapshottedAt,
        ...fields,
      });

    it('a higher generation wins and a lower one is rejected without mutating', async () => {
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-gen-basic';

      const successor = await write(repo, profileName, 'a', {
        snapshotLeaseGeneration: 2,
        snapshottedAt: '2026-06-12T00:00:00.000Z',
      });
      expect(successor.status).toBe('written');

      const stale = await write(repo, profileName, 'b', {
        snapshotLeaseGeneration: 1,
        snapshottedAt: '2026-06-12T00:01:00.000Z',
      });
      expect(stale.status).toBe('stale');

      const row = await repo.getBrowserProfileSnapshot(profileName);
      expect(row?.contentHash).toBe(hash('a'));
      expect(row?.snapshotLeaseGeneration).toBe(2);
    });

    it('a stale owner does NOT win on a fresher timestamp', async () => {
      // The whole point of the fence: the stale owner's Chrome kept writing
      // after handoff, so its clock is newer but its generation is older.
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-gen-clock';

      await write(repo, profileName, 'c', {
        snapshotLeaseGeneration: 5,
        snapshottedAt: '2026-06-12T01:00:00.000Z',
      });
      const staleButNewer = await write(repo, profileName, 'd', {
        snapshotLeaseGeneration: 4,
        snapshottedAt: '2026-06-12T09:00:00.000Z',
      });

      expect(staleButNewer.status).toBe('stale');
      expect(
        (await repo.getBrowserProfileSnapshot(profileName))?.contentHash,
      ).toBe(hash('c'));
    });

    it('the generation outranks a higher run fencing version', async () => {
      // Two independent sequences: a big run fence must not rescue an old
      // profile-lease generation.
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-gen-outranks';

      await write(repo, profileName, 'e', {
        snapshotLeaseGeneration: 3,
        snapshotFencingVersion: 1,
        snapshottedAt: '2026-06-12T02:00:00.000Z',
      });
      const olderGenerationHigherRunFence = await write(
        repo,
        profileName,
        'f',
        {
          snapshotLeaseGeneration: 2,
          snapshotFencingVersion: 99,
          snapshottedAt: '2026-06-12T02:05:00.000Z',
        },
      );

      expect(olderGenerationHigherRunFence.status).toBe('stale');
      expect(
        (await repo.getBrowserProfileSnapshot(profileName))?.contentHash,
      ).toBe(hash('e'));
    });

    it('within one generation the pre-existing run-fence rule still applies', async () => {
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-gen-tiebreak';

      await write(repo, profileName, 'g', {
        snapshotLeaseGeneration: 2,
        snapshotFencingVersion: 5,
        snapshottedAt: '2026-06-12T03:00:00.000Z',
      });
      const sameGenLowerFence = await write(repo, profileName, 'h', {
        snapshotLeaseGeneration: 2,
        snapshotFencingVersion: 4,
        snapshottedAt: '2026-06-12T03:05:00.000Z',
      });
      expect(sameGenLowerFence.status).toBe('stale');

      const sameGenHigherFence = await write(repo, profileName, 'i', {
        snapshotLeaseGeneration: 2,
        snapshotFencingVersion: 6,
        snapshottedAt: '2026-06-12T03:06:00.000Z',
      });
      expect(sameGenHigherFence.status).toBe('written');
    });

    it('rejects a stale generation against the LATEST ISSUED generation, even with no row yet', async () => {
      // The hole branch autoreview found: A owns generation 1 and releases; B
      // acquires generation 2 and starts using the profile but has not
      // published yet, so the row is absent (or still 0). A row-relative guard
      // would accept A's delayed write. The issued generation must reject it.
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-issued-fence';
      const leaseKey = `browser-profile:${profileName}`;
      await service.pool.query(
        `INSERT INTO runtime_lease_generations (lease_key, generation, holder, updated_at)
         VALUES ($1, 2, 'test', now())
         ON CONFLICT (lease_key) DO UPDATE SET generation = 2`,
        [leaseKey],
      );

      // No row exists yet: this is the INSERT path, which must be guarded too.
      const stale = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: hash('s'),
        storageRef: `browser-profiles/${profileName}/stale`,
        sizeBytes: 1,
        snapshotLeaseGeneration: 1,
        leaseKey,
        snapshottedAt: '2026-06-13T00:00:00.000Z',
        now: '2026-06-13T00:00:00.000Z',
      });
      expect(stale.status).toBe('stale');
      expect(await repo.getBrowserProfileSnapshot(profileName)).toBeNull();
    });

    it('serializes the fence against a concurrent generation bump', async () => {
      // MVCC: a scalar subquery would only see the statement snapshot, so a
      // successor committing a bump mid-write could stay invisible and the
      // stale write would publish. The upsert takes a ROW LOCK on the
      // generation, so a concurrent bump must wait for it.
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-concurrent';
      const leaseKey = `browser-profile:${profileName}`;
      await service.pool.query(
        `INSERT INTO runtime_lease_generations (lease_key, generation, holder, updated_at)
         VALUES ($1, 1, 'test', now())
         ON CONFLICT (lease_key) DO UPDATE SET generation = 1`,
        [leaseKey],
      );

      // Hold an exclusive lock on the generation row from another connection,
      // simulating a successor's bump in flight.
      const blocker = await service.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT generation FROM runtime_lease_generations WHERE lease_key = $1 FOR UPDATE',
        [leaseKey],
      );

      let settled = false;
      const writing = repo
        .upsertBrowserProfileSnapshot({
          profileName,
          contentHash: hash('v'),
          storageRef: `browser-profiles/${profileName}/concurrent`,
          sizeBytes: 1,
          snapshotLeaseGeneration: 1,
          leaseKey,
          snapshottedAt: '2026-06-13T03:00:00.000Z',
          now: '2026-06-13T03:00:00.000Z',
        })
        .then((result) => {
          settled = true;
          return result;
        });

      // The write must NOT complete while the generation row is locked.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      // The successor commits its bump to generation 2 and releases the lock.
      await blocker.query(
        'UPDATE runtime_lease_generations SET generation = 2 WHERE lease_key = $1',
        [leaseKey],
      );
      await blocker.query('COMMIT');
      blocker.release();

      // Now unblocked, the writer sees the COMMITTED generation 2 and its
      // generation-1 token is stale.
      const result = await writing;
      expect(result.status).toBe('stale');
      expect(await repo.getBrowserProfileSnapshot(profileName)).toBeNull();
    }, 20_000);

    it('rejects a generation that was never issued', async () => {
      // A corrupted or mismatched token must not write an arbitrarily high
      // durable fence: that would block every legitimate owner until the
      // counter caught up.
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-issued-future';
      const leaseKey = `browser-profile:${profileName}`;
      await service.pool.query(
        `INSERT INTO runtime_lease_generations (lease_key, generation, holder, updated_at)
         VALUES ($1, 2, 'test', now())
         ON CONFLICT (lease_key) DO UPDATE SET generation = 2`,
        [leaseKey],
      );

      const unissued = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: hash('u'),
        storageRef: `browser-profiles/${profileName}/future`,
        sizeBytes: 1,
        snapshotLeaseGeneration: 999,
        leaseKey,
        snapshottedAt: '2026-06-13T02:00:00.000Z',
        now: '2026-06-13T02:00:00.000Z',
      });

      expect(unissued.status).toBe('stale');
      expect(await repo.getBrowserProfileSnapshot(profileName)).toBeNull();
    });

    it('accepts the successor at the latest issued generation', async () => {
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-issued-ok';
      const leaseKey = `browser-profile:${profileName}`;
      await service.pool.query(
        `INSERT INTO runtime_lease_generations (lease_key, generation, holder, updated_at)
         VALUES ($1, 2, 'test', now())
         ON CONFLICT (lease_key) DO UPDATE SET generation = 2`,
        [leaseKey],
      );

      const successor = await repo.upsertBrowserProfileSnapshot({
        profileName,
        contentHash: hash('t'),
        storageRef: `browser-profiles/${profileName}/ok`,
        sizeBytes: 1,
        snapshotLeaseGeneration: 2,
        leaseKey,
        snapshottedAt: '2026-06-13T01:00:00.000Z',
        now: '2026-06-13T01:00:00.000Z',
      });
      expect(successor.status).toBe('written');
      // Assert the RETURNED snapshot, not just the re-read: the write path maps
      // raw SQL rows itself, so a mapping slip would surface only here.
      if (successor.status === 'written') {
        expect(successor.snapshot).toMatchObject({
          profileName,
          contentHash: hash('t'),
          storageRef: `browser-profiles/${profileName}/ok`,
          sizeBytes: 1,
          snapshotLeaseGeneration: 2,
        });
        // Types matter here: raw pg returns bigints as strings and timestamps
        // as Date objects, so assert the decoded shapes explicitly.
        expect(typeof successor.snapshot.sizeBytes).toBe('number');
        expect(typeof successor.snapshot.snapshotLeaseGeneration).toBe(
          'number',
        );
        expect(typeof successor.snapshot.snapshottedAt).toBe('string');
        // Both paths must agree on format; the repo stores Postgres text form.
        const readBack = await repo.getBrowserProfileSnapshot(profileName);
        expect(successor.snapshot.snapshottedAt).toBe(readBack?.snapshottedAt);
        expect(new Date(successor.snapshot.snapshottedAt).toISOString()).toBe(
          '2026-06-13T01:00:00.000Z',
        );
        expect(typeof successor.snapshot.createdAt).toBe('string');
      }
      expect(
        (await repo.getBrowserProfileSnapshot(profileName))?.contentHash,
      ).toBe(hash('t'));
    });

    it('supersedes a pre-upgrade row with no generation, without any backfill', async () => {
      // Upgrade path: rows written before this column existed read as 0.
      const repo = browserProfileSnapshots;
      const profileName = 'c-kai-gen-upgrade';

      const legacy = await write(repo, profileName, 'j', {
        snapshotFencingVersion: 42,
        snapshottedAt: '2026-06-12T04:00:00.000Z',
      });
      expect(legacy.status).toBe('written');
      expect(
        (await repo.getBrowserProfileSnapshot(profileName))
          ?.snapshotLeaseGeneration,
      ).toBe(0);

      const firstFenced = await write(repo, profileName, 'k', {
        snapshotLeaseGeneration: 1,
        snapshotFencingVersion: 1,
        snapshottedAt: '2026-06-12T04:01:00.000Z',
      });
      expect(firstFenced.status).toBe('written');
      expect(
        (await repo.getBrowserProfileSnapshot(profileName))?.contentHash,
      ).toBe(hash('k'));
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
          leases,
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
          leases,
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
