import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';
import { LocalToolchainArtifactStore } from '@core/adapters/artifacts/toolchains/local-toolchain-artifact-store.js';
import { loadRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { importFleetSettingsRevision } from '@core/config/settings/settings-import-service.js';
import { PostgresSettingsRevisionWakeupSource } from '@core/config/settings/settings-revision-notify.js';
import { enqueueToolchainBake } from '@core/jobs/toolchain-bake-enqueue.js';
import { executeToolchainBake } from '@core/jobs/toolchain-bake-executor.js';
import { normalizeToolchainManifest } from '@core/jobs/toolchain-bake-manifest.js';
import { ToolchainBakeReaper } from '@core/jobs/toolchain-bake-reaper.js';
import type { ToolchainCommandRunner } from '@core/jobs/toolchain-bake-runner.js';
import { PostgresManifestWakeupSource } from '@core/jobs/toolchain-manifest-listener.js';
import { PostgresToolchainManifestNotifier } from '@core/jobs/toolchain-manifest-notify.js';
import {
  WorkerCapabilityReconciler,
  toolchainCapabilityId,
} from '@core/jobs/worker-capability-reconciler.js';
import type { SkillArtifactMaterializer } from '@core/domain/ports/skill-artifact-store.js';
import { toIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const appId = DEFAULT_APP_ID;
const registry = 'https://registry.npmjs.org/';

// No skill artifacts are produced in this suite (no object-store skill rows), so
// the reconciler never calls the skill materializer. A call would be a bug.
const unusedSkillMaterializer: SkillArtifactMaterializer = {
  materializeSkillArtifact: async () => {
    throw new Error('skill materialize must not be called in this suite');
  },
};

/**
 * Fake npm runner: writes a deterministic node_modules + lockfile so the real
 * executor (real `--ignore-scripts` argv + registry-pinned `.npmrc`) can pack and
 * upload an artifact without ever hitting a registry. Mirrors the established
 * fake in toolchain-bake-reconciler.postgres.integration.test.ts.
 */
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

maybeDescribe('fleet capability-state chaos combo (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let localRoot: string;
  let workerInstanceId: string;

  // Long-lived LISTEN clients are torn down in afterAll regardless of test
  // outcome — an open LISTEN connection blocks the pool from closing.
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'chaos_combo',
    });
    // The fleet settings-revision apply path runs the real workstation import
    // (validate → write settings.yaml → reconcile desired state). That validation
    // legitimately requires the runtime storage URL env and a strong credential
    // key, exactly as production does — set them honestly here. No test-only
    // branch is added to production code.
    process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
    process.env.SECRET_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-chaos-local-'));
    workerInstanceId = `chaos-worker-${process.pid}`;
  }, 60_000);

  afterAll(async () => {
    for (const close of closers.splice(0)) {
      await close().catch(() => {});
    }
    if (localRoot) await fs.rm(localRoot, { recursive: true, force: true });
    await runtime?.cleanup();
  });

  it(
    'converges when a bake completes, a settings revision NOTIFYs, and a worker ' +
      'instance refreshes simultaneously',
    async () => {
      const deps = runtime.repositories;
      const store = new LocalToolchainArtifactStore(localRoot);
      const notifier = new PostgresToolchainManifestNotifier(
        runtime.service.pool,
      );

      // Manifest hashes for the two baked dependencies.
      const manifestA = normalizeToolchainManifest({
        packages: ['left-pad@1.3.0'],
        registry,
      }).manifestHash;
      const manifestB = normalizeToolchainManifest({
        packages: ['dayjs@1.11.20'],
        registry,
      }).manifestHash;

      // Recording queue shared by enqueue + reaper so we can assert dispatch
      // never duplicates or strands a manifest.
      const recordedEnqueues: { dependencyId: string; manifestHash: string }[] =
        [];
      const queue = {
        enqueueBake: async (input: {
          dependencyId: string;
          manifestHash: string;
        }) => {
          recordedEnqueues.push(input);
        },
      };

      // ---- Idempotent enqueue of dependency A (capability-matched dispatch
      //      idempotency leg) ----
      const firstEnqueue = await enqueueToolchainBake(
        { runtimeDependencies: deps.runtimeDependencies, queue, registry },
        { appId, packages: ['left-pad@1.3.0'] },
      );
      expect(firstEnqueue.status).toBe('enqueued');
      const dependencyAId = firstEnqueue.dependency.id;

      // Re-enqueueing the same packages must NOT create a second row or a second
      // queued bake (no duplicate/stranded bake rows).
      const dupEnqueue = await enqueueToolchainBake(
        { runtimeDependencies: deps.runtimeDependencies, queue, registry },
        { appId, packages: ['left-pad@1.3.0'] },
      );
      expect(dupEnqueue.status).toBe('already_present');
      expect(dupEnqueue.dependency.id).toBe(dependencyAId);
      expect(recordedEnqueues).toHaveLength(1);

      // Dependency B is enqueued then deliberately STRANDED in `baking` with a
      // back-dated `updated_at` to simulate a worker that hard-died mid-install.
      const enqueueB = await enqueueToolchainBake(
        { runtimeDependencies: deps.runtimeDependencies, queue, registry },
        { appId, packages: ['dayjs@1.11.20'] },
      );
      const dependencyBId = enqueueB.dependency.id;
      const staleIso = toIso(Date.now() - 60 * 60_000); // 1h ago
      await deps.runtimeDependencies.updateRuntimeDependencyStatus({
        id: dependencyBId,
        status: 'baking',
        fromStatus: 'queued',
        now: staleIso,
      });

      // ---- Register the worker with an empty capability set ----
      await deps.workerCoordination.registerWorker({
        id: workerInstanceId,
        bootNonce: 'boot-1',
        capabilities: [],
      });

      // ---- REAL Postgres LISTEN subscribers (prove NOTIFY round-trips) ----
      // Two independent LISTEN observers prove the manifest and settings NOTIFYs
      // actually round-trip over the wire. The reconciler is driven purely by
      // explicit `reconcile()` calls (no subscription, no poll timer), so there
      // is NO race for ordering — the only thing that advances state is an await
      // we control. We assert the wire round-trip separately via these observers.
      let manifestWakes = 0;
      const manifestObserver = new PostgresManifestWakeupSource(
        runtime.service.pool,
      );
      const manifestUnsub = manifestObserver.subscribe(() => {
        manifestWakes += 1;
      });
      closers.push(async () => {
        manifestUnsub();
        await manifestObserver.close();
      });

      let settingsWakes = 0;
      const settingsObserver = new PostgresSettingsRevisionWakeupSource(
        runtime.service.pool,
      );
      const settingsUnsub = settingsObserver.subscribe(() => {
        settingsWakes += 1;
      });
      closers.push(async () => {
        settingsUnsub();
        await settingsObserver.close();
      });

      // The reconciler gets its own (never-subscribed, timer-disabled) wakeup
      // source; we await reconcile() directly. stop() closes it.
      const reconcilerWakeSource = new PostgresManifestWakeupSource(
        runtime.service.pool,
      );

      // The reconciler is HELD until the first settings revision is applied,
      // mirroring fleet-boot's startCapabilitySubsystems gate. The test honors
      // that ordering by not driving reconcile() until the revision import
      // below succeeds; the boot gate itself (onFirstRevisionApplied) has
      // dedicated unit coverage and is not exercised here.
      const reconciler = new WorkerCapabilityReconciler({
        appId,
        workerInstanceId,
        runtimeDependencies: deps.runtimeDependencies,
        skills: deps.skills,
        toolchainMaterializer: store,
        skillMaterializer: unusedSkillMaterializer,
        workerRegistry: deps.workerCoordination,
        wakeupSource: reconcilerWakeSource,
        localRoot,
        pollIntervalMs: 1_000_000,
        imageInventory: () => ['browser'],
        setIntervalFn: (() => 0 as never) as typeof setInterval,
        clearIntervalFn: (() => {}) as typeof clearInterval,
      });
      // stop() closes the reconciler's wakeup source (the only LISTEN client it
      // owns). We never call start(): the test drives reconcile() explicitly so
      // no immediate/background pass can race the controlled interleaving.
      closers.push(() => reconciler.stop());

      // Let the two observer LISTEN clients attach before any NOTIFY is published.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // ===================================================================
      // SIMULTANEITY WINDOW: fire all three events back-to-back BEFORE draining
      // any of them. Every NOTIFY is in flight before the system reacts to any
      // single one — the deterministic stand-in for "at the same time".
      // ===================================================================

      // (1) Bake A completes against the REAL executor (real `--ignore-scripts`
      //     argv + registry-pinned `.npmrc`), firing the real `uploaded`
      //     manifest NOTIFY on gantry_runtime_dependencies.
      const bakeOutcome = await executeToolchainBake(
        {
          runtimeDependencies: deps.runtimeDependencies,
          toolchainStore: store,
          commandRunner: fakeNpmRunner(),
          notifier,
          outcomeNotice: {
            sendSuccessNotice: async () => {},
            sendFailureNotice: async () => {},
          },
          registry,
        },
        { dependencyId: dependencyAId },
      );
      expect(bakeOutcome.result).toBe('uploaded');

      // (2) Settings revision NOTIFY: append a real fleet revision (real append +
      //     real pg_notify on gantry_settings_revisions). The first applied
      //     revision releases the held reconciler.
      const settings = loadRuntimeSettings(process.env.GANTRY_HOME ?? '');
      const importOutcome = await importFleetSettingsRevision(
        {
          runtimeHome: process.env.GANTRY_HOME ?? '',
          ops: runtime.ops as never,
          repositories: runtime.repositories as never,
          appId,
          settingsRevisions: deps.settingsRevisions,
          pool: runtime.service.pool,
          createdBy: 'chaos-combo',
        },
        settings,
      );
      expect(importOutcome.status).toBe('applied');

      // (3) Worker instance refresh: the worker re-registers with a fresh boot
      //     nonce, which resets capabilities_json to empty (instance-refresh
      //     contract). This races the bake's `uploaded` NOTIFY.
      await deps.workerCoordination.registerWorker({
        id: workerInstanceId,
        bootNonce: 'boot-2',
        capabilities: [],
      });
      const refreshed =
        await deps.workerCoordination.getWorker(workerInstanceId);
      expect(refreshed?.capabilities).toEqual([]);

      // ---- Reaper recovers the stranded bake B over the same window ----
      const reaper = new ToolchainBakeReaper({
        runtimeDependencies: deps.runtimeDependencies,
        queue,
        notifier,
        stalenessMs: 15 * 60_000,
        now: () => Date.now(),
        setIntervalFn: (() => 0 as never) as typeof setInterval,
        clearIntervalFn: (() => {}) as typeof clearInterval,
      });
      const reapResult = await reaper.runOnce();
      expect(reapResult.requeued).toBe(1);
      const recoveredB =
        await deps.runtimeDependencies.getRuntimeDependency(dependencyBId);
      expect(recoveredB?.status).toBe('queued');
      // Re-enqueued exactly once by the reaper (initial enqueue + reaper).
      expect(
        recordedEnqueues.filter((e) => e.dependencyId === dependencyBId),
      ).toHaveLength(2);

      // ---- DRAIN: every NOTIFY fired above must have round-tripped ----
      await waitFor(
        () => manifestWakes >= 1,
        5_000,
        'manifest NOTIFY round-trip',
      );
      await waitFor(
        () => settingsWakes >= 1,
        5_000,
        'settings revision NOTIFY round-trip',
      );

      // ---- Converge: the released reconciler runs one pass and re-advertises --
      await reconciler.reconcile();

      // Dependency A flipped uploaded → activated by the first reconciler to
      // activate it (no lost capability advertising).
      const activatedA =
        await deps.runtimeDependencies.getRuntimeDependency(dependencyAId);
      expect(activatedA?.status).toBe('activated');

      // The refreshed worker re-advertised: image inventory ∪ activated toolchain
      // capability. The earlier capability set was NOT lost across the refresh —
      // it was re-derived from durable state, which is the correctness property.
      const worker = await deps.workerCoordination.getWorker(workerInstanceId);
      expect(worker?.capabilities.sort()).toEqual(
        ['browser', toolchainCapabilityId(manifestA)].sort(),
      );

      // ---- Complete the recovered bake B and prove a second reconcile pass
      //      advertises it too (no stuck dispatch) ----
      const bakeOutcomeB = await executeToolchainBake(
        {
          runtimeDependencies: deps.runtimeDependencies,
          toolchainStore: store,
          commandRunner: fakeNpmRunner(),
          notifier,
          outcomeNotice: {
            sendSuccessNotice: async () => {},
            sendFailureNotice: async () => {},
          },
          registry,
        },
        { dependencyId: dependencyBId },
      );
      expect(bakeOutcomeB.result).toBe('uploaded');
      await reconciler.reconcile();
      const workerFinal =
        await deps.workerCoordination.getWorker(workerInstanceId);
      expect(workerFinal?.capabilities.sort()).toEqual(
        [
          'browser',
          toolchainCapabilityId(manifestA),
          toolchainCapabilityId(manifestB),
        ].sort(),
      );

      // ---- No duplicate/stranded rows: exactly two dependency rows for our two
      //      manifests, both terminal-activated. ----
      const allDeps = await deps.runtimeDependencies.listRuntimeDependencies({
        appId,
      });
      const forThisApp = allDeps.filter(
        (row) =>
          row.manifestHash === manifestA || row.manifestHash === manifestB,
      );
      expect(forThisApp).toHaveLength(2);
      expect(forThisApp.every((row) => row.status === 'activated')).toBe(true);
    },
    60_000,
  );
});
