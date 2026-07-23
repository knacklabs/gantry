import { describe, expect, it, vi } from 'vitest';

import { SkillService } from '@core/application/skills/skill-service.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
  SkillId,
} from '@core/domain/skills/skills.js';

class MemorySkillRepository implements SkillCatalogRepository {
  readonly skills = new Map<string, SkillCatalogItem>();
  readonly bindings = new Map<string, AgentSkillBinding>();
  readonly listSkillsSpy = vi.fn(this.listSkillsImpl.bind(this));

  async getSkill(id: SkillId): Promise<SkillCatalogItem | null> {
    return this.skills.get(id) ?? null;
  }

  listSkills(input: {
    appId: string;
    agentId?: string;
    statuses?: SkillCatalogItem['status'][];
  }): Promise<SkillCatalogItem[]> {
    return this.listSkillsSpy(input);
  }

  private async listSkillsImpl(input: {
    appId: string;
    agentId?: string;
    statuses?: SkillCatalogItem['status'][];
  }): Promise<SkillCatalogItem[]> {
    return [...this.skills.values()].filter(
      (skill) =>
        skill.appId === input.appId &&
        (!input.agentId || skill.agentId === input.agentId) &&
        (!input.statuses || input.statuses.includes(skill.status)),
    );
  }

  async saveSkill(item: SkillCatalogItem): Promise<void> {
    this.skills.set(item.id, item);
  }

  async saveAgentSkillBinding(binding: AgentSkillBinding): Promise<void> {
    this.bindings.set(`${binding.agentId}:${binding.skillId}`, binding);
  }

  async disableAgentSkillBinding(input: {
    appId: string;
    agentId: string;
    skillId: SkillId;
    updatedAt: string;
  }): Promise<AgentSkillBinding | null> {
    const binding = this.bindings.get(`${input.agentId}:${input.skillId}`);
    if (!binding || binding.appId !== input.appId) return null;
    const disabled: AgentSkillBinding = {
      ...binding,
      status: 'disabled',
      updatedAt: input.updatedAt,
    };
    this.bindings.set(`${input.agentId}:${input.skillId}`, disabled);
    return disabled;
  }

  async listAgentSkillBindings(input: {
    appId: string;
    agentId: string;
  }): Promise<AgentSkillBinding[]> {
    return [...this.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId && binding.agentId === input.agentId,
    );
  }

  async listAgentSkillBindingsForAgents(input: {
    appId: string;
    agentIds: readonly string[];
  }): Promise<AgentSkillBinding[]> {
    const agentIds = new Set(input.agentIds);
    return [...this.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId && agentIds.has(binding.agentId),
    );
  }

  async listEnabledSkillsForAgent(input: {
    appId: string;
    agentId: string;
  }): Promise<SkillCatalogItem[]> {
    const skills: SkillCatalogItem[] = [];
    for (const binding of this.bindings.values()) {
      if (
        binding.appId !== input.appId ||
        binding.agentId !== input.agentId ||
        binding.status !== 'active'
      ) {
        continue;
      }
      const skill = this.skills.get(binding.skillId);
      if (skill?.status === 'installed') {
        skills.push(skill);
      }
    }
    return skills;
  }
}

class MemoryArtifactStore implements SkillArtifactStore {
  readonly bundles = new Map<
    string,
    Parameters<SkillArtifactStore['putSkillArtifact']>[0]['bundle']
  >();

  async putSkillArtifact(
    input: Parameters<SkillArtifactStore['putSkillArtifact']>[0],
  ) {
    const storageRef = `skills/${input.skillName}`;
    this.bundles.set(storageRef, input.bundle);
    return {
      storageType: 'local-filesystem' as const,
      storageRef,
      contentHash: `sha256:${Buffer.from(input.bundle.assets[0]?.content ?? '').toString('hex')}`,
      sizeBytes: input.bundle.assets.reduce(
        (sum, asset) => sum + asset.content.byteLength,
        0,
      ),
    };
  }

  async getSkillArtifact(storageRef: string) {
    const bundle = this.bundles.get(storageRef);
    if (!bundle) throw new Error(`Missing artifact: ${storageRef}`);
    return bundle;
  }
}

function createService() {
  const repo = new MemorySkillRepository();
  const artifacts = new MemoryArtifactStore();
  const service = new SkillService(repo, artifacts);
  return { repo, artifacts, service };
}

const asset = {
  path: 'SKILL.md',
  content: Buffer.from('# Durable skill'),
  contentType: 'text/markdown',
};

describe('SkillService', () => {
  it('installs an agent-created skill and materializes it only when bound', async () => {
    const { service } = createService();

    const skill = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'agent-skill',
      assets: [asset],
      now: '2026-04-28T00:00:00.000Z',
    });

    expect(skill.status).toBe('installed');
    expect(skill.storage?.storageRef).toContain('skills/');
    await expect(
      service.resolveLocalSkillsForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toEqual([]);
  });

  it('derives installed skill metadata from SKILL.md when context omits it', async () => {
    const { service } = createService();

    const skill = await service.installSkill({
      appId: 'app:one' as never,
      fallbackName: 'fallback-skill',
      assets: [
        {
          path: 'SKILL.md',
          content: Buffer.from(
            '---\nname: Uploaded Skill\ndescription: Zip metadata\n---\n# Skill',
          ),
        },
      ],
    });

    expect(skill.name).toBe('Uploaded Skill');
    expect(skill.description).toBe('Zip metadata');
  });

  it('parses skill action permissions from the skill manifest', async () => {
    const { service } = createService();

    const skill = await service.installSkill({
      appId: 'app:one' as never,
      assets: [
        {
          path: 'SKILL.md',
          content: Buffer.from('---\nname: linkedin-posting\n---\n# Skill'),
        },
        {
          path: 'gantry.skill.json',
          content: Buffer.from(
            JSON.stringify({
              actions: [
                {
                  id: 'publish',
                  capabilityId: 'skill.linkedin-posting.publish',
                  displayName: 'LinkedIn posting',
                  risk: 'write',
                  can: 'Publish a prepared LinkedIn post through the installed script.',
                  cannot:
                    'Read unrelated accounts or receive raw LinkedIn credentials.',
                  requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
                  commandTemplates: [
                    'python3 ${skillRoot}/post.py --file /tmp/post.md',
                  ],
                },
              ],
            }),
          ),
          contentType: 'application/json',
        },
      ],
    });

    expect(skill.requiredEnvVars).toEqual(['LINKEDIN_ACCESS_TOKEN']);
    expect(skill.actionPermissions).toEqual([
      {
        id: 'publish',
        capabilityId: 'skill.linkedin-posting.publish',
        displayName: 'LinkedIn posting',
        risk: 'write',
        can: 'Publish a prepared LinkedIn post through the installed script.',
        cannot: 'Read unrelated accounts or receive raw LinkedIn credentials.',
        requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
        commandTemplates: ['skills/linkedin-posting/post.py *'],
        networkHosts: [],
      },
    ]);
  });

  it('rejects skill names that collide with Gantry materialized skills', async () => {
    const { artifacts, service } = createService();

    await expect(
      service.installSkill({
        appId: 'app:one' as never,
        name: 'Gantry Admin',
        assets: [asset],
      }),
    ).rejects.toThrow('reserved Gantry skill directory "gantry-admin"');
    expect(artifacts.bundles.size).toBe(0);
  });

  it('rejects skill names that collide with SDK-native skills before storing', async () => {
    const { artifacts, service } = createService();

    await expect(
      service.installSkill({
        appId: 'app:one' as never,
        name: 'Commands',
        assets: [asset],
      }),
    ).rejects.toThrow('reserved SDK-native skill name "commands"');
    expect(artifacts.bundles.size).toBe(0);
  });

  it('rejects SKILL.md names that collide with SDK-native skills before storing', async () => {
    const { artifacts, service } = createService();

    await expect(
      service.installSkill({
        appId: 'app:one' as never,
        name: 'LinkedIn Posting',
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from(
              '---\nname: security-review\n---\n# Security Review',
            ),
            contentType: 'text/markdown',
          },
        ],
      }),
    ).rejects.toThrow('reserved SDK-native skill name "security-review"');
    expect(artifacts.bundles.size).toBe(0);
  });

  it('rejects SKILL.md names that do not align with the Gantry skill name before storing', async () => {
    const { artifacts, service } = createService();

    await expect(
      service.installSkill({
        appId: 'app:one' as never,
        name: 'LinkedIn Posting',
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from('---\nname: other-skill\n---\n# Other Skill'),
            contentType: 'text/markdown',
          },
        ],
      }),
    ).rejects.toThrow(
      'declares SDK skill name "other-skill" but materializes as "LinkedIn-Posting"',
    );
    expect(artifacts.bundles.size).toBe(0);
  });

  it('rejects unsafe skill action manifests', async () => {
    const { service } = createService();
    const importWithAction = (action: Record<string, unknown>) =>
      service.installSkill({
        appId: 'app:one' as never,
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from('---\nname: linkedin-posting\n---\n# Skill'),
          },
          {
            path: 'gantry.skill.json',
            content: Buffer.from(JSON.stringify({ actions: [action] })),
            contentType: 'application/json',
          },
        ],
      });
    const valid = {
      id: 'publish',
      capabilityId: 'skill.linkedin-posting.publish',
      displayName: 'LinkedIn posting',
      risk: 'write',
      can: 'Publish a prepared LinkedIn post.',
      cannot: 'Access unrelated credentials.',
      requiredEnvVars: [],
      commandTemplates: ['python3 ${skillRoot}/post.py --file /tmp/post.md'],
    };

    await expect(
      importWithAction({ ...valid, displayName: '' }),
    ).rejects.toThrow('displayName');
    await expect(
      importWithAction({
        ...valid,
        commandTemplates: ['python3 /tmp/post.py --file /tmp/post.md'],
      }),
    ).rejects.toThrow('skills/linkedin-posting');
    await expect(
      importWithAction({
        ...valid,
        commandTemplates: [
          'REQUESTS_CA_BUNDLE=/tmp/ca.pem python3 ${skillRoot}/post.py --file /tmp/post.md',
        ],
      }),
    ).rejects.toThrow('environment assignments');
    await expect(
      importWithAction({
        ...valid,
        commandTemplates: ['python3 ${skillRoot}/post.py --token secret'],
      }),
    ).rejects.toThrow('secret-like command parts');
  });

  it('materializes only installed and bound local skills', async () => {
    const { service } = createService();
    const skill = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'agent-skill',
      assets: [asset],
    });

    await service.bindSkillToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: skill.id,
    });

    const skills = await service.resolveLocalSkillsForAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('agent-skill');
  });

  it('replaces older active bindings that materialize to the same skill directory', async () => {
    const { repo, service } = createService();
    const first = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'LinkedIn Posting',
      assets: [asset],
    });
    const second = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'linkedin-posting',
      assets: [
        {
          ...asset,
          content: Buffer.from('# Durable skill v2'),
        },
      ],
    });
    await service.bindSkillToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: first.id,
      now: '2026-05-01T00:00:00.000Z',
    });
    await service.bindSkillToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: second.id,
      now: '2026-05-02T00:00:00.000Z',
    });

    expect(second.id).toBe(first.id);
    expect(repo.bindings.get(`agent:one:${second.id}`)).toMatchObject({
      status: 'active',
    });
    await expect(
      service.resolveLocalSkillsForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toMatchObject([{ id: second.id }]);
  });

  it('does not bind or materialize disabled skills', async () => {
    const { repo, service } = createService();
    const disabled: SkillCatalogItem = {
      id: 'skill:disabled' as SkillId,
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'disabled-skill',
      source: 'admin_uploaded',
      status: 'disabled',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skills/disabled.json',
        contentHash: 'sha256:disabled',
        sizeBytes: 1,
      },
      createdAt: '2026-04-28T00:00:00.000Z' as never,
      updatedAt: '2026-04-28T00:00:00.000Z' as never,
    };
    await repo.saveSkill(disabled);
    await expect(
      service.bindSkillToAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        skillId: disabled.id,
      }),
    ).rejects.toThrow('installed');

    const skill = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'disabled-skill',
      assets: [
        {
          ...asset,
          content: Buffer.from('# Disabled'),
        },
      ],
    });
    await service.bindSkillToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: skill.id,
    });
    await service.unbindSkillFromAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: skill.id,
    });

    const skills = await service.resolveLocalSkillsForAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
    });
    expect(skills).toEqual([]);
  });

  it('replaces imports by app and materialized skill name', async () => {
    const { repo, service } = createService();

    const first = await service.installSkill({
      appId: 'app:one' as never,
      name: 'LinkedIn Posting',
      assets: [asset],
    });
    const second = await service.installSkill({
      appId: 'app:one' as never,
      name: 'linkedin-posting',
      assets: [
        {
          ...asset,
          content: Buffer.from('# Durable skill v2'),
        },
      ],
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('linkedin-posting');
    expect(second.storage?.storageRef).toBe('skills/linkedin-posting');
    expect(repo.listSkillsSpy).toHaveBeenCalled();
  });

  it('does not return disabled matching content when reinstalling a skill', async () => {
    const { repo, service } = createService();
    const disabled: SkillCatalogItem = {
      id: 'skill:disabled-duplicate' as SkillId,
      appId: 'app:one' as never,
      name: 'disabled-duplicate',
      source: 'admin_uploaded',
      status: 'disabled',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skills/disabled-duplicate.json',
        contentHash: 'sha256:232044757261626c6520736b696c6c',
        sizeBytes: 15,
      },
      createdAt: '2026-04-28T00:00:00.000Z' as never,
      updatedAt: '2026-04-28T00:00:00.000Z' as never,
    };
    await repo.saveSkill(disabled);

    const installed = await service.installSkill({
      appId: 'app:one' as never,
      name: 'reinstalled',
      assets: [asset],
    });

    expect(installed.id).not.toBe(disabled.id);
    expect(installed.status).toBe('installed');
  });

  it('keeps different agent-originated skill names separate', async () => {
    const { service } = createService();

    const first = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'first-name',
      createdBy: 'agent:one',
      assets: [asset],
    });
    const second = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:two' as never,
      name: 'second-name',
      createdBy: 'agent:two',
      assets: [asset],
    });

    expect(second.id).not.toBe(first.id);
    expect(second.agentId).toBeUndefined();
    expect(second.name).toBe('second-name');
  });

  it('reuses one app skill identity for the same skill name across agents', async () => {
    const { service } = createService();

    const first = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'shared-name',
      createdBy: 'agent:one',
      assets: [asset],
    });
    const second = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:two' as never,
      name: 'Shared Name',
      createdBy: 'agent:two',
      assets: [{ ...asset, content: Buffer.from('# Shared v2') }],
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Shared Name');
    expect(second.agentId).toBeUndefined();
  });

  it('keeps different skill names separate even when content matches', async () => {
    const { service } = createService();

    const agentSkill = await service.installSkill({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'agent-owned',
      assets: [asset],
    });
    const adminSkill = await service.installSkill({
      appId: 'app:one' as never,
      name: 'admin-owned',
      assets: [asset],
    });
    const adminAgain = await service.installSkill({
      appId: 'app:one' as never,
      name: 'admin-owned-again',
      assets: [asset],
    });

    expect(adminSkill.id).not.toBe(agentSkill.id);
    expect(adminSkill.agentId).toBeUndefined();
    expect(adminSkill.name).toBe('admin-owned');
    expect(adminAgain.id).not.toBe(adminSkill.id);
  });

  it('rejects provider-native reserved skill names at install time, not next spawn', async () => {
    const { artifacts, service } = createService();

    // Trace defect 3: "claude-api" previously passed install and only failed
    // the NEXT Claude spawn in the materializer's reserved-name check.
    await expect(
      service.installSkill({
        appId: 'app:one' as never,
        name: 'Claude API',
        assets: [asset],
      }),
    ).rejects.toThrow('reserved SDK-native skill name "claude-api"');
    expect(artifacts.bundles.size).toBe(0);
  });

  it('reports an install-time materialization collision against a selected skill', async () => {
    const { repo, service } = createService();
    const now = '2026-07-20T00:00:00.000Z';
    const baseSkill = {
      appId: 'app:one' as never,
      source: 'agent_created' as const,
      status: 'installed' as const,
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      createdAt: now as never,
      updatedAt: now as never,
    };
    // Legacy/degenerate state: two installed same-key skills, and the agent is
    // bound to the one an install of "Alpha" would NOT replace in place.
    await repo.saveSkill({
      ...baseSkill,
      id: 'skill:a' as never,
      name: 'Alpha',
    });
    await repo.saveSkill({
      ...baseSkill,
      id: 'skill:b' as never,
      name: 'alpha',
    });
    await repo.saveAgentSkillBinding({
      id: 'agent-skill-binding:agent:one:skill:b' as never,
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: 'skill:b' as never,
      status: 'active',
      createdAt: now as never,
      updatedAt: now as never,
    });

    await expect(
      service.installMaterializationCollisionForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        name: 'Alpha',
        skillId: 'skill:a' as never,
      }),
    ).resolves.toContain(
      'materializes to the same runtime directory "alpha" as the currently selected skill alpha (skill:b)',
    );
    // In-place replacement of the SAME selected skill id is not a collision.
    await repo.saveAgentSkillBinding({
      id: 'agent-skill-binding:agent:one:skill:a' as never,
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: 'skill:a' as never,
      status: 'active',
      createdAt: now as never,
      updatedAt: now as never,
    });
    await repo.disableAgentSkillBinding({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: 'skill:b' as never,
      updatedAt: now,
    });
    await expect(
      service.installMaterializationCollisionForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        name: 'Alpha',
        skillId: 'skill:a' as never,
      }),
    ).resolves.toBeNull();

    await expect(
      service.installMaterializationCollisionForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        name: 'Alpha',
      }),
    ).resolves.toBeNull();

    await expect(
      service.installMaterializationCollisionForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        name: 'alpha',
      }),
    ).resolves.toContain('currently selected skill Alpha (skill:a)');
  });
});
