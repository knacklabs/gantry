import { describe, expect, it } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import {
  isWorkerEligibleForRequiredCapabilities,
  missingRequiredCapabilities,
  normalizeCapabilitySet,
  resolveRequiredCapabilities,
} from '@core/jobs/capability-eligibility.js';
import {
  skillCapabilityId,
  toolchainCapabilityId,
} from '@core/jobs/worker-capability-reconciler.js';

function skillsRepo(
  bindings: Array<{ skillId: string; status: 'active' | 'disabled' }>,
): SkillCatalogRepository {
  return {
    getSkill: async () => null,
    listSkills: async () => [],
    saveSkill: async () => {},
    saveAgentSkillBinding: async () => {},
    disableAgentSkillBinding: async () => null,
    listAgentSkillBindings: async () =>
      bindings.map((binding, index) => ({
        id: `binding-${index}` as never,
        appId: 'default' as never,
        agentId: 'agent:a' as never,
        skillId: binding.skillId as never,
        status: binding.status,
        createdAt: '2026-06-11T00:00:00.000Z' as never,
        updatedAt: '2026-06-11T00:00:00.000Z' as never,
      })),
    listAgentSkillBindingsForAgents: async () => [],
    listEnabledSkillsForAgent: async () => [],
  } as unknown as SkillCatalogRepository;
}

function depsRepo(rows: RuntimeDependency[]): RuntimeDependencyRepository {
  return {
    createRuntimeDependency: async () => {
      throw new Error('unused');
    },
    getRuntimeDependency: async () => null,
    getRuntimeDependencyByManifestHash: async () => null,
    listRuntimeDependencies: async (input) =>
      rows.filter(
        (row) =>
          row.appId === input.appId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    updateRuntimeDependencyStatus: async () => true,
  };
}

function dep(
  overrides: Partial<RuntimeDependency> & { manifestHash: string },
): RuntimeDependency {
  return {
    id: 'dep-1',
    appId: 'default',
    requestedPackages: ['left-pad@1.3.0'],
    status: 'uploaded',
    artifact: null,
    failureReason: null,
    requestedByAgentId: 'agent:a',
    approvedByConversationId: null,
    approvedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('isWorkerEligibleForRequiredCapabilities', () => {
  it('empty required set is eligible on any worker', () => {
    expect(isWorkerEligibleForRequiredCapabilities([], [])).toBe(true);
    expect(isWorkerEligibleForRequiredCapabilities([], ['skill:x'])).toBe(true);
  });

  it('is eligible when advertised is a superset of required', () => {
    expect(
      isWorkerEligibleForRequiredCapabilities(
        ['skill:a'],
        ['browser', 'skill:a', 'toolchain:h'],
      ),
    ).toBe(true);
  });

  it('is ineligible when any required id is missing', () => {
    expect(
      isWorkerEligibleForRequiredCapabilities(
        ['skill:a', 'toolchain:h'],
        ['skill:a'],
      ),
    ).toBe(false);
  });

  it('reports the missing ids', () => {
    expect(
      missingRequiredCapabilities(['skill:a', 'toolchain:h'], ['skill:a']),
    ).toEqual(['toolchain:h']);
  });
});

describe('normalizeCapabilitySet', () => {
  it('sorts, de-dupes, and trims', () => {
    expect(normalizeCapabilitySet([' skill:b ', 'skill:a', 'skill:b'])).toEqual(
      ['skill:a', 'skill:b'],
    );
    expect(normalizeCapabilitySet(null)).toEqual([]);
  });
});

describe('resolveRequiredCapabilities', () => {
  it('returns empty in workstation mode regardless of selections', async () => {
    const result = await resolveRequiredCapabilities(
      {
        deploymentMode: 'workstation',
        skills: skillsRepo([{ skillId: 's1', status: 'active' }]),
        runtimeDependencies: depsRepo([dep({ manifestHash: 'sha256:h1' })]),
      },
      { appId: 'default', agentId: 'agent:a' },
    );
    expect(result).toEqual([]);
  });

  it('includes active skills and this agent uploaded/activated toolchains in fleet mode', async () => {
    const result = await resolveRequiredCapabilities(
      {
        deploymentMode: 'fleet',
        skills: skillsRepo([
          { skillId: 's1', status: 'active' },
          { skillId: 's2', status: 'disabled' },
        ]),
        runtimeDependencies: depsRepo([
          dep({ manifestHash: 'sha256:h1', requestedByAgentId: 'agent:a' }),
          dep({
            id: 'dep-2',
            manifestHash: 'sha256:h2',
            requestedByAgentId: 'agent:other',
          }),
        ]),
      },
      { appId: 'default', agentId: 'agent:a' },
    );
    expect(result).toEqual(
      [skillCapabilityId('s1'), toolchainCapabilityId('sha256:h1')].sort(),
    );
  });

  it('returns empty when the agent has no fleet-distributed selections', async () => {
    const result = await resolveRequiredCapabilities(
      {
        deploymentMode: 'fleet',
        skills: skillsRepo([]),
        runtimeDependencies: depsRepo([]),
      },
      { appId: 'default', agentId: 'agent:a' },
    );
    expect(result).toEqual([]);
  });
});
