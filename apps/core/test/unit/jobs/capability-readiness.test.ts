import { describe, expect, it } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { WorkerRegistryRepository } from '@core/domain/ports/worker-coordination.js';
import {
  evaluateFleetCapabilityReadiness,
  fleetCapabilitySetupState,
} from '@core/jobs/capability-readiness.js';
import { toolchainCapabilityId } from '@core/jobs/worker-capability-reconciler.js';

function depsRepo(rows: RuntimeDependency[]): RuntimeDependencyRepository {
  return {
    createRuntimeDependency: async () => {
      throw new Error('unused');
    },
    getRuntimeDependency: async () => null,
    getRuntimeDependencyByManifestHash: async () => null,
    listRuntimeDependencies: async () => rows,
    updateRuntimeDependencyStatus: async () => true,
  };
}

const noSkills: SkillCatalogRepository = {
  getSkill: async () => null,
  listSkills: async () => [],
  saveSkill: async () => {},
  saveAgentSkillBinding: async () => {},
  disableAgentSkillBinding: async () => null,
  listAgentSkillBindings: async () => [],
  listAgentSkillBindingsForAgents: async () => [],
  listEnabledSkillsForAgent: async () => [],
} as unknown as SkillCatalogRepository;

function workerRegistry(active: string[][]): WorkerRegistryRepository {
  return {
    registerWorker: async () => {},
    heartbeatWorker: async () => true,
    markStaleWorkersUnhealthy: async () => [],
    listActiveWorkerCapabilities: async () => active,
    getWorker: async () => null,
    listWorkers: async () => [],
    advertiseWorkerCapabilities: async () => true,
  };
}

function toolchainDep(manifestHash: string): RuntimeDependency {
  return {
    id: 'dep-1',
    appId: 'default',
    manifestHash,
    requestedPackages: ['left-pad@1.3.0'],
    status: 'uploaded',
    artifact: null,
    failureReason: null,
    requestedByAgentId: 'agent:a',
    approvedByConversationId: null,
    approvedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  };
}

const input = { appId: 'default', agentId: 'agent:a' };

describe('evaluateFleetCapabilityReadiness', () => {
  it('is satisfiable in workstation mode regardless of selections', async () => {
    const result = await evaluateFleetCapabilityReadiness(
      {
        deploymentMode: 'workstation',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([]),
      },
      input,
    );
    expect(result.satisfiable).toBe(true);
    expect(result.requiredCapabilities).toEqual([]);
  });

  it('is satisfiable when an active worker advertises the set (local insufficiency is not a pause)', async () => {
    const cap = toolchainCapabilityId('sha256:h1');
    const result = await evaluateFleetCapabilityReadiness(
      {
        deploymentMode: 'fleet',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([['browser'], [cap]]),
        now: () => '2026-06-11T12:00:00.000Z',
      },
      input,
    );
    expect(result.satisfiable).toBe(true);
  });

  it('is unsatisfiable when no active worker advertises the set', async () => {
    const cap = toolchainCapabilityId('sha256:h1');
    const result = await evaluateFleetCapabilityReadiness(
      {
        deploymentMode: 'fleet',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([['browser']]),
        now: () => '2026-06-11T12:00:00.000Z',
      },
      input,
    );
    expect(result.satisfiable).toBe(false);
    expect(result.missingCapabilities).toEqual([cap]);
  });
});

describe('fleetCapabilitySetupState', () => {
  it('builds a user-actionable missing-capability blocker naming the dependency', () => {
    const state = fleetCapabilitySetupState({
      missingCapabilities: [toolchainCapabilityId('sha256:h1')],
      checkedAt: '2026-06-11T12:00:00.000Z',
    });
    expect(state.state).toBe('missing_capability');
    expect(state.blockers).toHaveLength(1);
    expect(state.blockers[0].requirementType).toBe('semantic_capability');
    expect(state.blockers[0].nextAction).toContain('bake');
  });

  it('produces a stable fingerprint and clears notified on change', () => {
    const a = fleetCapabilitySetupState({
      missingCapabilities: ['toolchain:h1'],
    });
    const b = fleetCapabilitySetupState({
      missingCapabilities: ['toolchain:h1'],
      previous: { ...a, notified_fingerprint: a.fingerprint },
    });
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.notified_fingerprint).toBe(a.fingerprint);
    const c = fleetCapabilitySetupState({
      missingCapabilities: ['toolchain:h2'],
      previous: { ...a, notified_fingerprint: a.fingerprint },
    });
    expect(c.notified_fingerprint).toBeNull();
  });
});
