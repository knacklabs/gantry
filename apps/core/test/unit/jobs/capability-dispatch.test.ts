import { describe, expect, it } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { Job } from '@core/domain/types.js';
import {
  decideCapabilityDispatch,
  ineligibleRequeueDelayMs,
  INELIGIBLE_REQUEUE_BASE_DELAY_MS,
  INELIGIBLE_REQUEUE_JITTER_MS,
  requiredCapabilitiesChanged,
} from '@core/jobs/capability-dispatch.js';
import { toolchainCapabilityId } from '@core/jobs/worker-capability-reconciler.js';

const job = { workspace_key: 'agent:a' } as Pick<Job, 'workspace_key'>;

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

describe('decideCapabilityDispatch', () => {
  it('is a no-op (eligible, empty set) in workstation mode', async () => {
    const decision = await decideCapabilityDispatch(
      {
        deploymentMode: 'workstation',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerAdvertisedCapabilities: async () => [],
      },
      job,
    );
    expect(decision).toEqual({ outcome: 'eligible', requiredCapabilities: [] });
  });

  it('is eligible when the required set is empty', async () => {
    const decision = await decideCapabilityDispatch(
      {
        deploymentMode: 'fleet',
        skills: noSkills,
        runtimeDependencies: depsRepo([]),
        workerAdvertisedCapabilities: async () => [],
      },
      job,
    );
    expect(decision.outcome).toBe('eligible');
    expect(decision.requiredCapabilities).toEqual([]);
  });

  it('is eligible when the worker advertises the required set', async () => {
    const cap = toolchainCapabilityId('sha256:h1');
    const decision = await decideCapabilityDispatch(
      {
        deploymentMode: 'fleet',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerAdvertisedCapabilities: async () => ['browser', cap],
      },
      job,
    );
    expect(decision.outcome).toBe('eligible');
    expect(decision.requiredCapabilities).toEqual([cap]);
  });

  it('is ineligible (with missing ids) when the worker lacks the required set', async () => {
    const cap = toolchainCapabilityId('sha256:h1');
    const decision = await decideCapabilityDispatch(
      {
        deploymentMode: 'fleet',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerAdvertisedCapabilities: async () => ['browser'],
      },
      job,
    );
    expect(decision).toEqual({
      outcome: 'ineligible',
      requiredCapabilities: [cap],
      missingCapabilities: [cap],
    });
  });

  it('skips the check (fail-open) when the advertised set is unavailable', async () => {
    const decision = await decideCapabilityDispatch(
      {
        deploymentMode: 'fleet',
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerAdvertisedCapabilities: async () => null,
      },
      job,
    );
    expect(decision.outcome).toBe('skip_check');
  });
});

describe('ineligibleRequeueDelayMs', () => {
  it('applies base delay plus jitter', () => {
    expect(ineligibleRequeueDelayMs(() => 0)).toBe(
      INELIGIBLE_REQUEUE_BASE_DELAY_MS,
    );
    const max = ineligibleRequeueDelayMs(() => 0.999999);
    expect(max).toBeGreaterThan(INELIGIBLE_REQUEUE_BASE_DELAY_MS);
    expect(max).toBeLessThanOrEqual(
      INELIGIBLE_REQUEUE_BASE_DELAY_MS + INELIGIBLE_REQUEUE_JITTER_MS,
    );
  });
});

describe('requiredCapabilitiesChanged', () => {
  it('detects added, removed, and reordered ids', () => {
    expect(requiredCapabilitiesChanged([], ['skill:a'])).toBe(true);
    expect(requiredCapabilitiesChanged(['skill:a'], [])).toBe(true);
    expect(requiredCapabilitiesChanged(['skill:a'], ['skill:a'])).toBe(false);
    expect(
      requiredCapabilitiesChanged(
        ['skill:b', 'skill:a'],
        ['skill:a', 'skill:b'],
      ),
    ).toBe(false);
    expect(requiredCapabilitiesChanged(null, [])).toBe(false);
  });
});
