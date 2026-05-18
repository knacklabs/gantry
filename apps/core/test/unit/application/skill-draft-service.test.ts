import { describe, expect, it, vi } from 'vitest';

import { SkillDraftService } from '@core/application/skills/skill-draft-service.js';
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

  async getSkillByContentHash(input: {
    appId: string;
    contentHash: string;
    agentId?: string | null;
    statuses?: SkillCatalogItem['status'][];
  }): Promise<SkillCatalogItem | null> {
    return (
      [...this.skills.values()].find(
        (skill) =>
          skill.appId === input.appId &&
          skill.storage?.contentHash === input.contentHash &&
          (input.agentId === null
            ? skill.agentId === undefined
            : input.agentId === undefined || skill.agentId === input.agentId) &&
          (!input.statuses || input.statuses.includes(skill.status)),
      ) ?? null
    );
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
      if (skill?.status === 'approved') {
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
    const storageRef = `skills/${input.skillId}.json`;
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
  const service = new SkillDraftService(repo, artifacts);
  return { repo, artifacts, service };
}

const asset = {
  path: 'SKILL.md',
  content: Buffer.from('# Durable skill'),
  contentType: 'text/markdown',
};

describe('SkillDraftService', () => {
  it('imports an agent-created skill as a durable draft that is not materialized', async () => {
    const { service } = createService();

    const draft = await service.importDraft({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'agent-skill',
      assets: [asset],
      now: '2026-04-28T00:00:00.000Z',
    });

    expect(draft.status).toBe('draft');
    expect(draft.storage?.storageRef).toContain('skills/');
    await expect(
      service.resolveLocalSkillsForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toEqual([]);
  });

  it('derives draft metadata from SKILL.md when upload context omits it', async () => {
    const { service } = createService();

    const draft = await service.importDraft({
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

    expect(draft.name).toBe('Uploaded Skill');
    expect(draft.description).toBe('Zip metadata');
  });

  it('materializes only approved and bound local skills', async () => {
    const { service } = createService();
    const draft = await service.importDraft({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'agent-skill',
      assets: [asset],
    });

    await service.approveDraft({
      appId: 'app:one' as never,
      skillId: draft.id,
      target: 'local',
    });
    await service.bindSkillToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: draft.id,
    });

    const skills = await service.resolveLocalSkillsForAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('agent-skill');
  });

  it('does not materialize rejected or disabled skills', async () => {
    const { service } = createService();
    const rejected = await service.importDraft({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'rejected-skill',
      assets: [asset],
    });
    await service.rejectDraft({
      appId: 'app:one' as never,
      skillId: rejected.id,
    });
    await expect(
      service.bindSkillToAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        skillId: rejected.id,
      }),
    ).rejects.toThrow('approved');

    const approved = await service.importDraft({
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
    await service.approveDraft({
      appId: 'app:one' as never,
      skillId: approved.id,
    });
    await service.bindSkillToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: approved.id,
    });
    await service.unbindSkillFromAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      skillId: approved.id,
    });

    const skills = await service.resolveLocalSkillsForAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
    });
    expect(skills).toEqual([]);
  });

  it('rejects only draft skills and preserves approval metadata', async () => {
    const { service } = createService();
    const draft = await service.importDraft({
      appId: 'app:one' as never,
      name: 'reviewed-skill',
      assets: [asset],
    });
    const approved = await service.approveDraft({
      appId: 'app:one' as never,
      skillId: draft.id,
      approvedBy: 'admin:one',
      now: '2026-04-28T00:00:00.000Z',
    });

    await expect(
      service.rejectDraft({
        appId: 'app:one' as never,
        skillId: approved.id,
        rejectedBy: 'admin:two',
      }),
    ).rejects.toThrow('Only draft skills can be rejected');
    expect(approved.approvedBy).toBe('admin:one');

    const second = await service.importDraft({
      appId: 'app:one' as never,
      name: 'second-skill',
      assets: [
        {
          ...asset,
          content: Buffer.from('# Second'),
        },
      ],
    });
    const rejected = await service.rejectDraft({
      appId: 'app:one' as never,
      skillId: second.id,
      rejectedBy: 'admin:two',
      now: '2026-04-28T01:00:00.000Z',
    });

    expect(rejected.rejectedBy).toBe('admin:two');
    expect(rejected.rejectedAt).toBe('2026-04-28T01:00:00.000Z');
    expect(rejected.approvedBy).toBeUndefined();
  });

  it('approves only draft skills and preserves rejection metadata', async () => {
    const { service } = createService();
    const draft = await service.importDraft({
      appId: 'app:one' as never,
      name: 'reviewed-skill',
      assets: [asset],
    });
    const rejected = await service.rejectDraft({
      appId: 'app:one' as never,
      skillId: draft.id,
      rejectedBy: 'admin:rejector',
      now: '2026-04-28T00:00:00.000Z',
    });

    await expect(
      service.approveDraft({
        appId: 'app:one' as never,
        skillId: rejected.id,
        approvedBy: 'admin:approver',
      }),
    ).rejects.toThrow('Only draft skills can be approved');
    expect(rejected.rejectedBy).toBe('admin:rejector');
  });

  it('deduplicates imports by app and content hash', async () => {
    const { repo, service } = createService();

    const first = await service.importDraft({
      appId: 'app:one' as never,
      name: 'first-name',
      assets: [asset],
    });
    const second = await service.importDraft({
      appId: 'app:one' as never,
      name: 'second-name',
      assets: [asset],
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('first-name');
    expect(repo.listSkillsSpy).not.toHaveBeenCalled();
  });

  it('creates separate agent-originated drafts even when content hashes match', async () => {
    const { service } = createService();

    const first = await service.importDraft({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'first-name',
      createdBy: 'agent:one',
      assets: [asset],
    });
    const second = await service.importDraft({
      appId: 'app:one' as never,
      agentId: 'agent:two' as never,
      name: 'second-name',
      createdBy: 'agent:two',
      assets: [asset],
    });

    expect(second.id).not.toBe(first.id);
    expect(second.agentId).toBe('agent:two');
    expect(second.name).toBe('second-name');
  });

  it('keeps admin and agent duplicate scopes separate for identical content', async () => {
    const { service } = createService();

    const agentDraft = await service.importDraft({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      name: 'agent-owned',
      assets: [asset],
    });
    const adminDraft = await service.importDraft({
      appId: 'app:one' as never,
      name: 'admin-owned',
      assets: [asset],
    });
    const adminAgain = await service.importDraft({
      appId: 'app:one' as never,
      name: 'admin-owned-again',
      assets: [asset],
    });

    expect(adminDraft.id).not.toBe(agentDraft.id);
    expect(adminDraft.agentId).toBeUndefined();
    expect(adminDraft.name).toBe('admin-owned');
    expect(adminAgain.id).toBe(adminDraft.id);
  });
});
