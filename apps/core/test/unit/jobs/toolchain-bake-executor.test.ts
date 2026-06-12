import path from 'node:path';
import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
  UpdateRuntimeDependencyStatusInput,
} from '@core/domain/ports/fleet-capability-state.js';
import type {
  StoredToolchainArtifact,
  ToolchainArtifactFile,
  ToolchainArtifactStore,
} from '@core/domain/ports/toolchain-artifact-store.js';
import {
  executeToolchainBake,
  type ToolchainBakeNotifier,
  type ToolchainBakeOutcomeNotice,
} from '@core/jobs/toolchain-bake-executor.js';
import { enqueueToolchainBake } from '@core/jobs/toolchain-bake-enqueue.js';
import type { ToolchainCommandRunner } from '@core/jobs/toolchain-bake-runner.js';
import { SYSTEM_PACKAGE_ERROR } from '@core/jobs/toolchain-bake-manifest.js';
import { hashToolchainFiles } from '@core/adapters/artifacts/toolchains/toolchain-artifact-bundle.js';

class FakeRuntimeDependencyRepository implements RuntimeDependencyRepository {
  rows = new Map<string, RuntimeDependency>();

  async createRuntimeDependency(input: {
    id: string;
    appId: string;
    manifestHash: string;
    requestedPackages: string[];
    requestedByAgentId?: string | null;
    approvedByConversationId?: string | null;
    approvedAt?: string | null;
    now?: string;
  }): Promise<RuntimeDependency> {
    for (const row of this.rows.values()) {
      if (
        row.appId === input.appId &&
        row.manifestHash === input.manifestHash
      ) {
        return row;
      }
    }
    const now = input.now ?? '2026-06-11T00:00:00.000Z';
    const row: RuntimeDependency = {
      id: input.id,
      appId: input.appId,
      manifestHash: input.manifestHash,
      requestedPackages: input.requestedPackages,
      status: 'queued',
      artifact: null,
      failureReason: null,
      requestedByAgentId: input.requestedByAgentId ?? null,
      approvedByConversationId: input.approvedByConversationId ?? null,
      approvedAt: input.approvedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async getRuntimeDependency(id: string): Promise<RuntimeDependency | null> {
    return this.rows.get(id) ?? null;
  }

  async getRuntimeDependencyByManifestHash(input: {
    appId: string;
    manifestHash: string;
  }): Promise<RuntimeDependency | null> {
    for (const row of this.rows.values()) {
      if (
        row.appId === input.appId &&
        row.manifestHash === input.manifestHash
      ) {
        return row;
      }
    }
    return null;
  }

  async listRuntimeDependencies(input: {
    appId: string;
    statuses?: RuntimeDependency['status'][];
  }): Promise<RuntimeDependency[]> {
    return [...this.rows.values()].filter(
      (row) =>
        row.appId === input.appId &&
        (!input.statuses || input.statuses.includes(row.status)),
    );
  }

  async updateRuntimeDependencyStatus(
    input: UpdateRuntimeDependencyStatusInput,
  ): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row) return false;
    if (input.fromStatus !== undefined) {
      const from = Array.isArray(input.fromStatus)
        ? input.fromStatus
        : [input.fromStatus];
      if (!from.includes(row.status)) return false;
    }
    row.status = input.status;
    if (input.artifact !== undefined) row.artifact = input.artifact;
    if (input.failureReason !== undefined) {
      row.failureReason = input.failureReason;
    }
    row.updatedAt = input.now ?? '2026-06-11T00:00:01.000Z';
    return true;
  }
}

class FakeToolchainStore implements ToolchainArtifactStore {
  puts: Array<{ manifestHash: string; files: ToolchainArtifactFile[] }> = [];

  async putToolchainArtifact(input: {
    appId: string;
    manifestHash: string;
    files: ToolchainArtifactFile[];
  }): Promise<StoredToolchainArtifact> {
    this.puts.push({ manifestHash: input.manifestHash, files: input.files });
    return {
      storageType: 'object-store',
      storageRef: `toolchains/${input.manifestHash.replace('sha256:', '')}`,
      contentHash: hashToolchainFiles(input.files),
      sizeBytes: input.files.reduce((sum, f) => sum + f.content.byteLength, 0),
    };
  }
}

class RecordingNotifier implements ToolchainBakeNotifier {
  notifications: Array<{ manifestHash: string; status: string }> = [];
  async notifyManifestChanged(input: {
    appId: string;
    manifestHash: string;
    status: RuntimeDependency['status'];
  }): Promise<void> {
    this.notifications.push({
      manifestHash: input.manifestHash,
      status: input.status,
    });
  }
}

class RecordingOutcomeNotice implements ToolchainBakeOutcomeNotice {
  successNotices: Array<{ id: string; packages: string[] }> = [];
  failureNotices: Array<{ id: string; reason: string }> = [];
  async sendSuccessNotice(input: {
    dependency: RuntimeDependency;
  }): Promise<void> {
    this.successNotices.push({
      id: input.dependency.id,
      packages: input.dependency.requestedPackages,
    });
  }
  async sendFailureNotice(input: {
    dependency: RuntimeDependency;
    reason: string;
  }): Promise<void> {
    this.failureNotices.push({ id: input.dependency.id, reason: input.reason });
  }
}

const registry = 'https://registry.npmjs.org/';

function fakeNpmRunner(
  onInstall: (workDir: string) => Promise<void>,
  exitCode = 0,
): ToolchainCommandRunner {
  return {
    async run(input) {
      await onInstall(input.cwd);
      return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'boom' };
    },
  };
}

async function seedQueuedRow(
  repo: FakeRuntimeDependencyRepository,
): Promise<RuntimeDependency> {
  return repo.createRuntimeDependency({
    id: 'dep-1',
    appId: 'app-1',
    manifestHash: 'sha256:abc',
    requestedPackages: ['left-pad@1.3.0'],
  });
}

describe('executeToolchainBake', () => {
  let tmpRoots: string[] = [];

  beforeEach(() => {
    tmpRoots = [];
  });

  afterEach(async () => {
    for (const dir of tmpRoots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('runs queued→baking→uploaded on the happy path and NOTIFYs', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    await seedQueuedRow(repo);
    const store = new FakeToolchainStore();
    const notifier = new RecordingNotifier();
    const outcomeNotice = new RecordingOutcomeNotice();
    const runner = fakeNpmRunner(async (workDir) => {
      const nm = path.join(workDir, 'node_modules', 'left-pad');
      await fs.mkdir(nm, { recursive: true });
      await fs.writeFile(path.join(nm, 'index.js'), 'module.exports = 1;\n');
      await fs.chmod(path.join(nm, 'index.js'), 0o755);
      await fs.mkdir(path.join(workDir, 'node_modules', '.bin'), {
        recursive: true,
      });
      await fs.symlink(
        '../left-pad/index.js',
        path.join(workDir, 'node_modules', '.bin', 'left-pad'),
      );
      await fs.writeFile(
        path.join(workDir, 'package-lock.json'),
        '{"lockfileVersion":3}\n',
      );
    });

    const outcome = await executeToolchainBake(
      {
        runtimeDependencies: repo,
        toolchainStore: store,
        commandRunner: runner,
        notifier,
        outcomeNotice,
        registry,
      },
      { dependencyId: 'dep-1' },
    );

    expect(outcome).toEqual({ result: 'uploaded', manifestHash: 'sha256:abc' });
    const row = await repo.getRuntimeDependency('dep-1');
    expect(row?.status).toBe('uploaded');
    expect(row?.artifact?.storageRef).toContain('toolchains/');
    expect(row?.artifact?.contentHash).toMatch(/^sha256:/);
    expect(store.puts).toHaveLength(1);
    // package.json + lockfile + .npmrc + node_modules file all packed.
    const packed = store.puts[0].files.map((f) => f.path).sort();
    expect(packed).toContain('package.json');
    expect(packed).toContain('package-lock.json');
    expect(packed).toContain('node_modules/left-pad/index.js');
    const bin = store.puts[0].files.find(
      (file) => file.path === 'node_modules/.bin/left-pad',
    );
    expect(bin).toMatchObject({
      kind: 'symlink',
      linkTarget: '../left-pad/index.js',
    });
    const executable = store.puts[0].files.find(
      (file) => file.path === 'node_modules/left-pad/index.js',
    );
    expect(executable?.mode).toBe(0o755);
    expect(notifier.notifications).toEqual([
      { manifestHash: 'sha256:abc', status: 'baking' },
      { manifestHash: 'sha256:abc', status: 'uploaded' },
    ]);
    // The approval conversation gets ONE success notice naming the packages.
    expect(outcomeNotice.successNotices).toEqual([
      { id: 'dep-1', packages: ['left-pad@1.3.0'] },
    ]);
    expect(outcomeNotice.failureNotices).toHaveLength(0);
  });

  it('logs and does not fail the bake when the success notice delivery throws', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    await seedQueuedRow(repo);
    const warnings: string[] = [];
    const runner = fakeNpmRunner(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'node_modules'), { recursive: true });
    });

    const outcome = await executeToolchainBake(
      {
        runtimeDependencies: repo,
        toolchainStore: new FakeToolchainStore(),
        commandRunner: runner,
        notifier: new RecordingNotifier(),
        outcomeNotice: {
          sendSuccessNotice: async () => {
            throw new Error('channel unavailable');
          },
          sendFailureNotice: async () => {},
        },
        registry,
        logWarn: (_context, message) => {
          warnings.push(message);
        },
      },
      { dependencyId: 'dep-1' },
    );

    expect(outcome).toEqual({ result: 'uploaded', manifestHash: 'sha256:abc' });
    expect((await repo.getRuntimeDependency('dep-1'))?.status).toBe('uploaded');
    expect(warnings).toContain(
      'Failed to deliver toolchain bake success notice',
    );
  });

  it('marks the row failed and sends a notice when npm install fails', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    await seedQueuedRow(repo);
    const outcomeNotice = new RecordingOutcomeNotice();
    const notifier = new RecordingNotifier();

    const outcome = await executeToolchainBake(
      {
        runtimeDependencies: repo,
        toolchainStore: new FakeToolchainStore(),
        commandRunner: fakeNpmRunner(async () => {}, 1),
        notifier,
        outcomeNotice,
        registry,
      },
      { dependencyId: 'dep-1' },
    );

    expect(outcome.result).toBe('failed');
    const row = await repo.getRuntimeDependency('dep-1');
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toMatch(/npm install failed/);
    expect(outcomeNotice.failureNotices).toHaveLength(1);
    expect(outcomeNotice.successNotices).toHaveLength(0);
    expect(notifier.notifications.map((n) => n.status)).toContain('failed');
  });

  it('short-circuits when the row is not claimable (already baking)', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    const row = await seedQueuedRow(repo);
    row.status = 'baking';
    const runner = fakeNpmRunner(async () => {
      throw new Error('should not run');
    });

    const outcome = await executeToolchainBake(
      {
        runtimeDependencies: repo,
        toolchainStore: new FakeToolchainStore(),
        commandRunner: runner,
        notifier: new RecordingNotifier(),
        outcomeNotice: new RecordingOutcomeNotice(),
        registry,
      },
      { dependencyId: 'dep-1' },
    );

    expect(outcome).toEqual({ result: 'skipped', reason: 'not_claimable' });
    expect(row.status).toBe('baking');
  });

  it('treats a lost uploaded-CAS after a mid-bake reap as a benign no-op', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    await seedQueuedRow(repo);
    const notifier = new RecordingNotifier();
    const outcomeNotice = new RecordingOutcomeNotice();
    // Simulate the reaper firing mid-install: the row is CAS-reset to queued
    // exactly as resetToolchainBakeForRequeue does.
    const runner = fakeNpmRunner(async (workDir) => {
      await fs.writeFile(
        path.join(workDir, 'package-lock.json'),
        '{"lockfileVersion":3}\n',
      );
      const reaped = await repo.updateRuntimeDependencyStatus({
        id: 'dep-1',
        status: 'queued',
        fromStatus: 'baking',
        failureReason: null,
      });
      expect(reaped).toBe(true);
    });

    const outcome = await executeToolchainBake(
      {
        runtimeDependencies: repo,
        toolchainStore: new FakeToolchainStore(),
        commandRunner: runner,
        notifier,
        outcomeNotice,
        registry,
      },
      { dependencyId: 'dep-1' },
    );

    expect(outcome).toEqual({ result: 'skipped', reason: 'not_claimable' });
    const row = await repo.getRuntimeDependency('dep-1');
    // The reaped row is owned by the requeued bake now; the loser's terminal
    // write must not land.
    expect(row?.status).toBe('queued');
    expect(notifier.notifications.map((n) => n.status)).toEqual(['baking']);
    expect(outcomeNotice.successNotices).toHaveLength(0);
    expect(outcomeNotice.failureNotices).toHaveLength(0);
  });

  it('treats a lost failed-CAS after a mid-bake reap as a benign no-op (no failure notice)', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    await seedQueuedRow(repo);
    const notifier = new RecordingNotifier();
    const outcomeNotice = new RecordingOutcomeNotice();
    const runner = fakeNpmRunner(async () => {
      const reaped = await repo.updateRuntimeDependencyStatus({
        id: 'dep-1',
        status: 'queued',
        fromStatus: 'baking',
        failureReason: null,
      });
      expect(reaped).toBe(true);
    }, 1);

    const outcome = await executeToolchainBake(
      {
        runtimeDependencies: repo,
        toolchainStore: new FakeToolchainStore(),
        commandRunner: runner,
        notifier,
        outcomeNotice,
        registry,
      },
      { dependencyId: 'dep-1' },
    );

    expect(outcome).toEqual({ result: 'skipped', reason: 'not_claimable' });
    const row = await repo.getRuntimeDependency('dep-1');
    expect(row?.status).toBe('queued');
    expect(row?.failureReason).toBeNull();
    expect(notifier.notifications.map((n) => n.status)).toEqual(['baking']);
    expect(outcomeNotice.failureNotices).toHaveLength(0);
  });

  it('is idempotent: a second enqueue for the same manifest does not duplicate the row', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    const enqueued: string[] = [];
    const queue = {
      async enqueueBake(input: { dependencyId: string }) {
        enqueued.push(input.dependencyId);
      },
    };

    const first = await enqueueToolchainBake(
      { runtimeDependencies: repo, queue, registry },
      { appId: 'app-1', packages: ['left-pad@1.3.0'] },
    );
    const second = await enqueueToolchainBake(
      { runtimeDependencies: repo, queue, registry },
      { appId: 'app-1', packages: ['left-pad@1.3.0'] },
    );

    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('already_present');
    expect(second.deduplicated).toBe(true);
    expect(first.dependency.id).toBe(second.dependency.id);
    expect(enqueued).toEqual([first.dependency.id]);
    expect(repo.rows.size).toBe(1);
  });

  it('rejects a non-npm/system-package spec with the ADR-2 error', async () => {
    const repo = new FakeRuntimeDependencyRepository();
    await expect(
      enqueueToolchainBake(
        {
          runtimeDependencies: repo,
          queue: { enqueueBake: async () => {} },
          registry,
        },
        { appId: 'app-1', packages: ['ffmpeg', 'git+https://x/y.git'] },
      ),
    ).rejects.toThrow(new RegExp(SYSTEM_PACKAGE_ERROR));
    expect(repo.rows.size).toBe(0);
  });
});
