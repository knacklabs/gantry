import { describe, expect, it, vi } from 'vitest';

import { resolveSelectedSkillProjection } from '@core/application/skills/selected-skill-projection.js';
import {
  type SkillArtifactBundle,
  type SkillArtifactStore,
} from '@core/domain/ports/skill-artifact-store.js';
import { hashSkillBundle } from '@core/shared/skill-artifact-helpers.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SkillCatalogItem } from '@core/domain/skills/skills.js';

const bundle: SkillArtifactBundle = {
  assets: [
    {
      path: 'SKILL.md',
      contentType: 'text/markdown',
      content: Buffer.from('# Projected skill\n'),
    },
  ],
};

describe('resolveSelectedSkillProjection', () => {
  it('projects an artifact whose bytes match the catalog hash', async () => {
    const projection = await resolveSelectedSkillProjection({
      selectedSkillIds: ['skill:projected'],
      skillRepository: repository(skill(hashSkillBundle(bundle))),
      skillArtifactStore: artifactStore(bundle),
      skillContext: { appId: 'app:test', agentId: 'agent:test' },
    });

    expect(projection?.skills[0]).toMatchObject({
      id: 'skill:projected',
      name: 'projected',
      contentHash: hashSkillBundle(bundle),
    });
    expect(
      Buffer.from(projection!.skills[0]!.assets[0]!.content).toString(),
    ).toBe('# Projected skill\n');
  });

  it('fails closed when the artifact bytes do not match the catalog hash', async () => {
    await expect(
      resolveSelectedSkillProjection({
        selectedSkillIds: ['skill:projected'],
        skillRepository: repository(skill('sha256:catalog-hash')),
        skillArtifactStore: artifactStore(bundle),
        skillContext: { appId: 'app:test', agentId: 'agent:test' },
      }),
    ).rejects.toThrow(
      'Selected skill "skill:projected" artifact integrity check failed',
    );
  });
});

function skill(contentHash: string): SkillCatalogItem {
  return {
    id: 'skill:projected' as never,
    appId: 'app:test' as never,
    agentId: 'agent:test' as never,
    name: 'projected',
    source: 'admin_uploaded',
    status: 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    storage: {
      storageType: 'local-filesystem',
      storageRef: 'apps/app-test/skills/skill-projected/content-hash',
      contentHash,
      sizeBytes: bundle.assets[0]!.content.byteLength,
    },
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  };
}

function repository(skillItem: SkillCatalogItem): SkillCatalogRepository {
  return {
    listEnabledSkillsForAgent: vi.fn(async () => [skillItem]),
  } as Partial<SkillCatalogRepository> as SkillCatalogRepository;
}

function artifactStore(skillBundle: SkillArtifactBundle): SkillArtifactStore {
  return {
    getSkillArtifact: vi.fn(async () => skillBundle),
  } as Partial<SkillArtifactStore> as SkillArtifactStore;
}
