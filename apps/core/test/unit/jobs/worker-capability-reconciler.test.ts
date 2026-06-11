import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
  UpdateRuntimeDependencyStatusInput,
} from '@core/domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import {
  ArtifactIntegrityError,
  type MaterializedSkillArtifact,
  type SkillArtifactMaterializer,
} from '@core/domain/ports/skill-artifact-store.js';
import type {
  MaterializedToolchainArtifact,
  ToolchainArtifactMaterializer,
} from '@core/domain/ports/toolchain-artifact-store.js';
import type { WorkerRegistryRepository } from '@core/domain/ports/worker-coordination.js';
import type { ManifestWakeupSource } from '@core/jobs/toolchain-manifest-listener.js';
import {
  WorkerCapabilityReconciler,
  skillCapabilityId,
  toolchainCapabilityId,
} from '@core/jobs/worker-capability-reconciler.js';

class FakeWakeupSource implements ManifestWakeupSource {
  private listeners = new Set<() => void>();
  closed = false;
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }
  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function depRepo(rows: RuntimeDependency[]): RuntimeDependencyRepository {
  const map = new Map(rows.map((row) => [row.id, row]));
  return {
    createRuntimeDependency: async () => {
      throw new Error('unused');
    },
    getRuntimeDependency: async (id) => map.get(id) ?? null,
    getRuntimeDependencyByManifestHash: async () => null,
    listRuntimeDependencies: async (input) =>
      [...map.values()].filter(
        (row) =>
          row.appId === input.appId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    updateRuntimeDependencyStatus: async (
      input: UpdateRuntimeDependencyStatusInput,
    ) => {
      const row = map.get(input.id);
      if (!row) return false;
      if (input.fromStatus !== undefined) {
        const from = Array.isArray(input.fromStatus)
          ? input.fromStatus
          : [input.fromStatus];
        if (!from.includes(row.status)) return false;
      }
      row.status = input.status;
      return true;
    },
  };
}

const emptySkills: SkillCatalogRepository = {
  getSkill: async () => null,
  listSkills: async () => [],
  saveSkill: async () => {},
  saveAgentSkillBinding: async () => {},
  disableAgentSkillBinding: async () => null,
  listAgentSkillBindings: async () => [],
  listAgentSkillBindingsForAgents: async () => [],
  listEnabledSkillsForAgent: async () => [],
} as unknown as SkillCatalogRepository;

function uploadedToolchain(
  id: string,
  manifestHash: string,
  contentHash: string,
): RuntimeDependency {
  return {
    id,
    appId: 'app-1',
    manifestHash,
    requestedPackages: ['left-pad@1.3.0'],
    status: 'uploaded',
    artifact: {
      storageType: 'object-store',
      storageRef: `toolchains/${manifestHash.replace('sha256:', '')}`,
      contentHash,
      sizeBytes: 10,
    },
    failureReason: null,
    requestedByAgentId: null,
    approvedByConversationId: null,
    approvedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  };
}

function okToolchainMaterializer(): ToolchainArtifactMaterializer {
  return {
    materializeToolchainArtifact: async (
      input,
    ): Promise<MaterializedToolchainArtifact> => ({
      storageRef: input.storageRef,
      contentHash: input.expectedContentHash,
      targetDir: input.targetDir,
      sizeBytes: 10,
    }),
  };
}

const noopSkillMaterializer: SkillArtifactMaterializer = {
  materializeSkillArtifact: async (
    input,
  ): Promise<MaterializedSkillArtifact> => ({
    storageRef: input.storageRef,
    contentHash: input.expectedContentHash,
    targetDir: input.targetDir,
    sizeBytes: 1,
  }),
};

function registry(): {
  repo: WorkerRegistryRepository;
  advertised: string[][];
} {
  const advertised: string[][] = [];
  const repo: WorkerRegistryRepository = {
    registerWorker: async () => {},
    heartbeatWorker: async () => true,
    markStaleWorkersUnhealthy: async () => [],
    listActiveWorkerCapabilities: async () => [],
    getWorker: async () => null,
    listWorkers: async () => [],
    advertiseWorkerCapabilities: async (input) => {
      advertised.push(input.capabilities);
      return true;
    },
  };
  return { repo, advertised };
}

describe('WorkerCapabilityReconciler', () => {
  beforeEach(() => {
    delete process.env.GANTRY_IMAGE_CAPABILITIES_JSON;
  });
  afterEach(() => {
    delete process.env.GANTRY_IMAGE_CAPABILITIES_JSON;
  });

  it('activates a toolchain, advertises it merged with image inventory, and flips the row', async () => {
    const rows = [uploadedToolchain('dep-1', 'sha256:m1', 'sha256:c1')];
    const repo = depRepo(rows);
    const reg = registry();
    const reconciler = new WorkerCapabilityReconciler({
      appId: 'app-1',
      workerInstanceId: 'worker-1',
      runtimeDependencies: repo,
      skills: emptySkills,
      toolchainMaterializer: okToolchainMaterializer(),
      skillMaterializer: noopSkillMaterializer,
      workerRegistry: reg.repo,
      wakeupSource: new FakeWakeupSource(),
      localRoot: '/tmp/gantry-reconciler-test',
      imageInventory: () => ['browser'],
    });

    await reconciler.reconcile();

    expect(rows[0].status).toBe('activated');
    expect(reg.advertised).toHaveLength(1);
    expect(reg.advertised[0].sort()).toEqual(
      ['browser', toolchainCapabilityId('sha256:m1')].sort(),
    );
  });

  it('wakes on NOTIFY and reconciles', async () => {
    const rows = [uploadedToolchain('dep-1', 'sha256:m1', 'sha256:c1')];
    const source = new FakeWakeupSource();
    const reg = registry();
    const reconciler = new WorkerCapabilityReconciler({
      appId: 'app-1',
      workerInstanceId: 'worker-1',
      runtimeDependencies: depRepo(rows),
      skills: emptySkills,
      toolchainMaterializer: okToolchainMaterializer(),
      skillMaterializer: noopSkillMaterializer,
      workerRegistry: reg.repo,
      wakeupSource: source,
      localRoot: '/tmp/gantry-reconciler-test',
      pollIntervalMs: 1_000_000,
      imageInventory: () => [],
      setIntervalFn: (() => 0 as never) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    reconciler.start();
    await vi.waitFor(() => expect(reg.advertised.length).toBeGreaterThan(0));
    reg.advertised.length = 0;
    source.fire();
    await vi.waitFor(() => expect(reg.advertised.length).toBeGreaterThan(0));
    await reconciler.stop();
  });

  it('recovers a dropped NOTIFY through the interval poll fallback', async () => {
    const rows = [uploadedToolchain('dep-1', 'sha256:m1', 'sha256:c1')];
    const reg = registry();
    let pollFn: (() => void) | null = null;
    const reconciler = new WorkerCapabilityReconciler({
      appId: 'app-1',
      workerInstanceId: 'worker-1',
      runtimeDependencies: depRepo(rows),
      skills: emptySkills,
      toolchainMaterializer: okToolchainMaterializer(),
      skillMaterializer: noopSkillMaterializer,
      workerRegistry: reg.repo,
      wakeupSource: new FakeWakeupSource(),
      localRoot: '/tmp/gantry-reconciler-test',
      imageInventory: () => [],
      // Capture the poll callback instead of running a real timer.
      setIntervalFn: ((fn: () => void) => {
        pollFn = fn;
        return 0 as never;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    reconciler.start();
    await vi.waitFor(() => expect(reg.advertised.length).toBeGreaterThan(0));
    reg.advertised.length = 0;
    expect(pollFn).toBeTypeOf('function');
    pollFn?.();
    await vi.waitFor(() => expect(reg.advertised.length).toBeGreaterThan(0));
    await reconciler.stop();
  });

  it('quarantines on integrity error, raises an audit event, and does not advertise the artifact', async () => {
    const rows = [uploadedToolchain('dep-1', 'sha256:m1', 'sha256:c1')];
    const reg = registry();
    const events: string[] = [];
    const reconciler = new WorkerCapabilityReconciler({
      appId: 'app-1',
      workerInstanceId: 'worker-1',
      runtimeDependencies: depRepo(rows),
      skills: emptySkills,
      toolchainMaterializer: {
        materializeToolchainArtifact: async (input) => {
          throw new ArtifactIntegrityError({
            storageRef: input.storageRef,
            expectedContentHash: input.expectedContentHash,
            actualContentHash: 'sha256:tampered',
            quarantinePath: '/tmp/quarantine/x',
          });
        },
      },
      skillMaterializer: noopSkillMaterializer,
      workerRegistry: reg.repo,
      wakeupSource: new FakeWakeupSource(),
      localRoot: '/tmp/gantry-reconciler-test',
      imageInventory: () => ['browser'],
      onIntegrityError: (event) => events.push(event.capabilityId),
    });

    await reconciler.reconcile();

    expect(events).toEqual([toolchainCapabilityId('sha256:m1')]);
    expect(rows[0].status).toBe('uploaded');
    expect(reg.advertised).toHaveLength(1);
    expect(reg.advertised[0]).toEqual(['browser']);
    expect(reg.advertised[0]).not.toContain(toolchainCapabilityId('sha256:m1'));
  });

  it('advertises object-store skills as skill:<id> capability ids', async () => {
    const skills: SkillCatalogRepository = {
      ...emptySkills,
      listSkills: async () => [
        {
          id: 'skill-1',
          appId: 'app-1',
          name: 'demo',
          source: 'agent',
          status: 'installed',
          promptRefs: [],
          toolIds: [],
          workflowRefs: [],
          storage: {
            storageType: 'object-store',
            storageRef: 'skills/demo',
            contentHash: 'sha256:s1',
            sizeBytes: 5,
          },
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      ],
    } as unknown as SkillCatalogRepository;
    const reg = registry();
    const reconciler = new WorkerCapabilityReconciler({
      appId: 'app-1',
      workerInstanceId: 'worker-1',
      runtimeDependencies: depRepo([]),
      skills,
      toolchainMaterializer: okToolchainMaterializer(),
      skillMaterializer: noopSkillMaterializer,
      workerRegistry: reg.repo,
      wakeupSource: new FakeWakeupSource(),
      localRoot: '/tmp/gantry-reconciler-test',
      imageInventory: () => [],
    });

    await reconciler.reconcile();

    expect(reg.advertised[0]).toEqual([skillCapabilityId('skill-1')]);
  });

  it('stops cleanly: closes the wakeup source and stops reconciling', async () => {
    const source = new FakeWakeupSource();
    const reg = registry();
    const reconciler = new WorkerCapabilityReconciler({
      appId: 'app-1',
      workerInstanceId: 'worker-1',
      runtimeDependencies: depRepo([]),
      skills: emptySkills,
      toolchainMaterializer: okToolchainMaterializer(),
      skillMaterializer: noopSkillMaterializer,
      workerRegistry: reg.repo,
      wakeupSource: source,
      localRoot: '/tmp/gantry-reconciler-test',
      setIntervalFn: (() => 0 as never) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    reconciler.start();
    await reconciler.stop();
    expect(source.closed).toBe(true);
    reg.advertised.length = 0;
    source.fire();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reg.advertised).toHaveLength(0);
  });
});
