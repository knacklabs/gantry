import { describe, expect, it, vi } from 'vitest';

import { resolveDeepAgentSkillProjection } from '@core/adapters/llm/deepagents-langchain/skill-projection.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SkillCatalogItem } from '@core/domain/skills/skills.js';

const now = '2026-06-16T00:00:00.000Z';

function skill(input: {
  id: string;
  name: string;
  storageRef?: string;
  status?: SkillCatalogItem['status'];
}): SkillCatalogItem {
  return {
    id: input.id as never,
    appId: 'app:test' as never,
    agentId: 'agent:test' as never,
    name: input.name,
    source: 'admin_uploaded',
    status: input.status ?? 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    ...(input.storageRef
      ? {
          storage: {
            storageType: 'local-filesystem' as const,
            storageRef: input.storageRef,
            contentHash: `sha256:${input.storageRef}`,
            sizeBytes: 1,
          },
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function repository(skills: SkillCatalogItem[]): SkillCatalogRepository {
  return {
    listEnabledSkillsForAgent: vi.fn(async () => skills),
  } as Partial<SkillCatalogRepository> as SkillCatalogRepository;
}

function artifactStore(
  bundles: Record<
    string,
    Parameters<SkillArtifactStore['putSkillArtifact']>[0]['bundle']
  >,
): SkillArtifactStore & { artifactRefs: string[] } {
  const artifactRefs: string[] = [];
  return {
    artifactRefs,
    getSkillArtifact: vi.fn(async (storageRef: string) => {
      artifactRefs.push(storageRef);
      const bundle = bundles[storageRef];
      if (!bundle) throw new Error(`Missing bundle ${storageRef}`);
      return bundle;
    }),
  } as Partial<SkillArtifactStore> as SkillArtifactStore & {
    artifactRefs: string[];
  };
}

function skillMd(input: { name: string; description?: string }): Buffer {
  return Buffer.from(`---
name: ${input.name}
description: ${input.description ?? 'Use this skill for release notes.'}
---

# ${input.name}
`);
}

describe('DeepAgents selected skill projection', () => {
  it('projects only selected materializable skill artifacts as virtual /skills files', async () => {
    const store = artifactStore({
      'skill-release': {
        assets: [
          {
            path: 'SKILL.md',
            content: skillMd({ name: 'release-writer' }),
            contentType: 'text/markdown',
          },
          {
            path: 'references/checklist.md',
            content: Buffer.from('# Checklist\n'),
            contentType: 'text/markdown',
          },
        ],
      },
      'skill-skipped': {
        assets: [
          {
            path: 'SKILL.md',
            content: skillMd({ name: 'skipped-skill' }),
          },
        ],
      },
    });

    const projection = await resolveDeepAgentSkillProjection({
      selectedSkillIds: ['skill:release', 'skill:release'],
      skillRepository: repository([
        skill({
          id: 'skill:release',
          name: 'release-writer',
          storageRef: 'skill-release',
        }),
        skill({
          id: 'skill:skipped',
          name: 'skipped-skill',
          storageRef: 'skill-skipped',
        }),
      ]),
      skillArtifactStore: store,
      skillContext: {
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
      },
      nowIso: () => now,
    });

    expect(store.artifactRefs).toEqual(['skill-release']);
    expect(projection).toMatchObject({
      sources: ['/skills/'],
      selectedSkillIds: ['skill:release'],
      skillCount: 1,
      fileCount: 2,
      contentBytes: expect.any(Number),
    });
    expect(projection?.files).toEqual({
      '/skills/release-writer/SKILL.md': {
        content: expect.stringContaining('name: release-writer'),
        mimeType: 'text/markdown',
        created_at: now,
        modified_at: now,
      },
      '/skills/release-writer/references/checklist.md': {
        content: '# Checklist\n',
        mimeType: 'text/markdown',
        created_at: now,
        modified_at: now,
      },
    });
  });

  it('returns undefined when no skills are selected', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: [],
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when selected skills lack configured storage dependencies', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:release'],
      }),
    ).rejects.toThrow('require configured Gantry skill storage');
  });

  it('fails closed when a selected skill is not enabled for the agent', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:missing'],
        skillRepository: repository([]),
        skillArtifactStore: artifactStore({}),
        skillContext: {
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
        },
      }),
    ).rejects.toThrow('is not enabled for this agent');
  });

  it('fails closed when a selected skill has no materializable artifact', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:release'],
        skillRepository: repository([
          skill({ id: 'skill:release', name: 'release-writer' }),
        ]),
        skillArtifactStore: artifactStore({}),
        skillContext: {
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
        },
      }),
    ).rejects.toThrow('is not installed with a materializable artifact');
  });

  it('fails closed when the artifact does not include SKILL.md', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:release'],
        skillRepository: repository([
          skill({
            id: 'skill:release',
            name: 'release-writer',
            storageRef: 'skill-release',
          }),
        ]),
        skillArtifactStore: artifactStore({
          'skill-release': {
            assets: [{ path: 'README.md', content: Buffer.from('# Nope') }],
          },
        }),
        skillContext: {
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
        },
      }),
    ).rejects.toThrow('artifact must include SKILL.md');
  });

  it('fails closed when artifact paths are unsafe', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:release'],
        skillRepository: repository([
          skill({
            id: 'skill:release',
            name: 'release-writer',
            storageRef: 'skill-release',
          }),
        ]),
        skillArtifactStore: artifactStore({
          'skill-release': {
            assets: [
              {
                path: 'SKILL.md',
                content: skillMd({ name: 'release-writer' }),
              },
              { path: '../escape.md', content: Buffer.from('nope') },
            ],
          },
        }),
        skillContext: {
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
        },
      }),
    ).rejects.toThrow('Invalid skill asset path');
  });

  it('fails closed when SKILL.md metadata cannot be loaded by DeepAgents skills', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:release'],
        skillRepository: repository([
          skill({
            id: 'skill:release',
            name: 'release-writer',
            storageRef: 'skill-release',
          }),
        ]),
        skillArtifactStore: artifactStore({
          'skill-release': {
            assets: [
              {
                path: 'SKILL.md',
                content: skillMd({ name: 'release_notes' }),
              },
            ],
          },
        }),
        skillContext: {
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
        },
      }),
    ).rejects.toThrow('declares SDK skill name "release_notes"');
  });

  it('fails closed when selected skills collide in the materialized directory', async () => {
    await expect(
      resolveDeepAgentSkillProjection({
        selectedSkillIds: ['skill:one', 'skill:two'],
        skillRepository: repository([
          skill({ id: 'skill:one', name: 'release-writer', storageRef: 'one' }),
          skill({ id: 'skill:two', name: 'Release Writer', storageRef: 'two' }),
        ]),
        skillArtifactStore: artifactStore({}),
        skillContext: {
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
        },
      }),
    ).rejects.toThrow('same runtime directory "release-writer"');
  });
});
