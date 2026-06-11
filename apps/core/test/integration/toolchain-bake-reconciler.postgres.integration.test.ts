import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';
import { LocalToolchainArtifactStore } from '@core/adapters/artifacts/toolchains/local-toolchain-artifact-store.js';
import { executeToolchainBake } from '@core/jobs/toolchain-bake-executor.js';
import { enqueueToolchainBake } from '@core/jobs/toolchain-bake-enqueue.js';
import { normalizeToolchainManifest } from '@core/jobs/toolchain-bake-manifest.js';
import { PostgresToolchainManifestNotifier } from '@core/jobs/toolchain-manifest-notify.js';
import { PostgresManifestWakeupSource } from '@core/jobs/toolchain-manifest-listener.js';
import {
  WorkerCapabilityReconciler,
  toolchainCapabilityId,
} from '@core/jobs/worker-capability-reconciler.js';
import type { ToolchainCommandRunner } from '@core/jobs/toolchain-bake-runner.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SkillArtifactMaterializer } from '@core/domain/ports/skill-artifact-store.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

const appId = DEFAULT_APP_ID;
const registry = 'https://registry.npmjs.org/';

// No skills are activated in this suite; the reconciler only touches toolchains.
const unusedSkillMaterializer: SkillArtifactMaterializer = {
  materializeSkillArtifact: async () => {
    throw new Error('skill materialize should not be called');
  },
};

const emptySkills = {
  getSkill: async () => null,
  listSkills: async () => [],
  saveSkill: async () => {},
  saveAgentSkillBinding: async () => {},
  disableAgentSkillBinding: async () => null,
  listAgentSkillBindings: async () => [],
  listAgentSkillBindingsForAgents: async () => [],
  listEnabledSkillsForAgent: async () => [],
} as unknown as SkillCatalogRepository;

// Fake npm runner: writes a deterministic node_modules + lockfile without ever
// hitting the registry.
function fakeNpmRunner(): ToolchainCommandRunner {
  return {
    async run(input) {
      const nm = path.join(input.cwd, 'node_modules', 'left-pad');
      await fs.mkdir(nm, { recursive: true });
      await fs.writeFile(path.join(nm, 'index.js'), 'module.exports = 1;\n');
      await fs.writeFile(
        path.join(input.cwd, 'package-lock.json'),
        '{"lockfileVersion":3}\n',
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

maybeDescribe(
  'toolchain bake → NOTIFY → reconciler advertise (Postgres)',
  () => {
    let service: PostgresStorageService;
    let repositories: PostgresDomainRepositoryBundle;
    let schemaName: string;
    let artifactRoot: string;
    let localRoot: string;

    beforeAll(async () => {
      schemaName = `bake_reconcile_test_${process.pid}_${Date.now()}`;
      service = new PostgresStorageService(
        process.env.GANTRY_TEST_DATABASE_URL ?? '',
        schemaName,
      );
      await service.migrate();
      repositories = createPostgresDomainRepositories(service.db, service.pool);
      artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-tc-art-'));
      localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-tc-local-'));
    }, 60_000);

    afterAll(async () => {
      for (const dir of [artifactRoot, localRoot]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      if (!service) return;
      await service.pool.query(
        `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
      );
      await service.close();
    });

    it('bakes a row, NOTIFYs, and the reconciler activates + advertises it', async () => {
      const store = new LocalToolchainArtifactStore(artifactRoot);
      const notifier = new PostgresToolchainManifestNotifier(service.pool);

      // Enqueue (idempotent) — record the row, no real queue needed here.
      const enqueueResult = await enqueueToolchainBake(
        {
          runtimeDependencies: repositories.runtimeDependencies,
          queue: { enqueueBake: async () => {} },
          registry,
        },
        { appId, packages: ['left-pad@1.3.0'] },
      );
      expect(enqueueResult.status).toBe('enqueued');
      const dependencyId = enqueueResult.dependency.id;
      const manifestHash = normalizeToolchainManifest({
        packages: ['left-pad@1.3.0'],
        registry,
      }).manifestHash;

      // Register a worker whose capabilities the reconciler will advertise into.
      const workerInstanceId = `worker-${process.pid}`;
      await repositories.workerCoordination.registerWorker({
        id: workerInstanceId,
        bootNonce: 'nonce-1',
        capabilities: [],
      });

      // Run the bake against the real repo + local store + fake npm runner.
      const bakeOutcome = await executeToolchainBake(
        {
          runtimeDependencies: repositories.runtimeDependencies,
          toolchainStore: store,
          commandRunner: fakeNpmRunner(),
          notifier,
          outcomeNotice: {
            sendSuccessNotice: async () => {},
            sendFailureNotice: async () => {},
          },
          registry,
        },
        { dependencyId },
      );
      expect(bakeOutcome.result).toBe('uploaded');
      const uploadedRow =
        await repositories.runtimeDependencies.getRuntimeDependency(
          dependencyId,
        );
      expect(uploadedRow?.status).toBe('uploaded');
      expect(uploadedRow?.artifact?.storageRef).toContain('toolchains/');

      // Wire the reconciler over the real NOTIFY/LISTEN source and drive one pass
      // via an injected wakeup. The LISTEN source proves the channel round-trips.
      const wakeupSource = new PostgresManifestWakeupSource(service.pool);
      const reconciler = new WorkerCapabilityReconciler({
        appId,
        workerInstanceId,
        runtimeDependencies: repositories.runtimeDependencies,
        skills: emptySkills,
        toolchainMaterializer: store,
        skillMaterializer: unusedSkillMaterializer,
        workerRegistry: repositories.workerCoordination,
        wakeupSource,
        localRoot,
        pollIntervalMs: 1_000_000,
        imageInventory: () => ['browser'],
      });

      let woke = false;
      const unsubscribe = wakeupSource.subscribe(() => {
        woke = true;
      });
      // Allow LISTEN to attach, then publish a manifest NOTIFY.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await notifier.notifyManifestChanged({
        appId,
        manifestHash,
        status: 'uploaded',
      });
      await vi_waitFor(() => woke, 5_000);
      unsubscribe();

      await reconciler.reconcile();

      const activatedRow =
        await repositories.runtimeDependencies.getRuntimeDependency(
          dependencyId,
        );
      expect(activatedRow?.status).toBe('activated');
      const worker =
        await repositories.workerCoordination.getWorker(workerInstanceId);
      expect(worker?.capabilities.sort()).toEqual(
        ['browser', toolchainCapabilityId(manifestHash)].sort(),
      );

      await reconciler.stop();
    });
  },
);

async function vi_waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for manifest NOTIFY wakeup');
}
