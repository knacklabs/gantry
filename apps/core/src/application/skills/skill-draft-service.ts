import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillArtifactStore } from '../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type {
  AgentSkillBinding,
  AgentSkillBindingId,
  SkillCatalogItem,
  SkillId,
  SkillStatus,
} from '../../domain/skills/skills.js';
import {
  isSkillMaterializableLocally,
  isSkillUsableForBinding,
} from '../../domain/skills/skills.js';
import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../../domain/capability-secrets/capability-secrets.js';
import { nowIso } from '../../shared/time/datetime.js';

export class SkillDraftService {
  constructor(
    private readonly skills: SkillCatalogRepository,
    private readonly artifacts: SkillArtifactStore,
  ) {}

  async importDraft(input: {
    appId: AppId;
    agentId?: AgentId;
    name?: string;
    description?: string;
    fallbackName?: string;
    requiredEnvVars?: string[];
    createdBy?: string;
    assets: Array<{
      path: string;
      contentType?: string;
      content: Uint8Array;
    }>;
    now?: string;
  }): Promise<SkillCatalogItem> {
    const now = input.now ?? nowIso();
    const skillId = `skill:${globalThis.crypto.randomUUID()}` as SkillId;
    const stored = await this.artifacts.putSkillArtifact({
      appId: input.appId,
      skillId,
      bundle: { assets: input.assets },
    });
    const existing = await this.findExistingSkillByContentHash({
      appId: input.appId,
      agentId: input.agentId,
      contentHash: stored.contentHash,
    });
    if (existing) return existing;
    const metadata = resolveSkillMetadata({
      assets: input.assets,
      name: input.name,
      description: input.description,
      fallbackName: input.fallbackName,
      requiredEnvVars: input.requiredEnvVars,
    });
    const skill: SkillCatalogItem = {
      id: skillId,
      appId: input.appId,
      agentId: input.agentId,
      name: metadata.name,
      description: metadata.description,
      version: stored.contentHash.replace(/^sha256:/, '').slice(0, 12),
      source: input.agentId ? 'agent_created' : 'admin_uploaded',
      status: 'draft',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      requiredEnvVars: metadata.requiredEnvVars,
      storage: stored,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.skills.saveSkill(skill);
    return skill;
  }

  listDrafts(input: {
    appId: AppId;
    agentId?: AgentId;
    statuses?: SkillStatus[];
  }): Promise<SkillCatalogItem[]> {
    return this.skills.listSkills({
      appId: input.appId,
      agentId: input.agentId,
      statuses: input.statuses ?? ['draft'],
    });
  }

  async approveDraft(input: {
    appId: AppId;
    skillId: SkillId;
    approvedBy?: string;
    now?: string;
  }): Promise<SkillCatalogItem> {
    const skill = await this.requireSkill(input.appId, input.skillId);
    if (skill.status !== 'draft') {
      throw new Error(`Only draft skills can be approved: ${skill.id}`);
    }
    if (!skill.storage) {
      throw new Error(`Skill draft has no stored artifact: ${skill.id}`);
    }
    const now = input.now ?? nowIso();
    const approved: SkillCatalogItem = {
      ...skill,
      status: 'approved',
      approvedBy: input.approvedBy,
      approvedAt: now,
      rejectedBy: undefined,
      rejectedAt: undefined,
      updatedAt: now,
    };
    await this.skills.saveSkill(approved);
    return approved;
  }

  async rejectDraft(input: {
    appId: AppId;
    skillId: SkillId;
    rejectedBy?: string;
    now?: string;
  }): Promise<SkillCatalogItem> {
    const skill = await this.requireSkill(input.appId, input.skillId);
    if (skill.status !== 'draft') {
      throw new Error(`Only draft skills can be rejected: ${skill.id}`);
    }
    const now = input.now ?? nowIso();
    const rejected: SkillCatalogItem = {
      ...skill,
      status: 'rejected',
      rejectedBy: input.rejectedBy,
      rejectedAt: now,
      updatedAt: now,
    };
    await this.skills.saveSkill(rejected);
    return rejected;
  }

  async bindSkillToAgent(input: {
    appId: AppId;
    agentId: AgentId;
    skillId: SkillId;
    now?: string;
  }): Promise<AgentSkillBinding> {
    const skill = await this.requireSkill(input.appId, input.skillId);
    if (!isSkillUsableForBinding(skill)) {
      throw new Error(`Skill must be approved before binding: ${skill.id}`);
    }
    const now = input.now ?? nowIso();
    const binding: AgentSkillBinding = {
      id: `agent-skill-binding:${input.agentId}:${input.skillId}` as AgentSkillBindingId,
      appId: input.appId,
      agentId: input.agentId,
      skillId: input.skillId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.skills.saveAgentSkillBinding(binding);
    return binding;
  }

  unbindSkillFromAgent(input: {
    appId: AppId;
    agentId: AgentId;
    skillId: SkillId;
    now?: string;
  }): Promise<AgentSkillBinding | null> {
    return this.skills.disableAgentSkillBinding({
      appId: input.appId,
      agentId: input.agentId,
      skillId: input.skillId,
      updatedAt: input.now ?? nowIso(),
    });
  }

  async rollbackApprovedSkillBinding(input: {
    appId: AppId;
    agentId: AgentId;
    skillId: SkillId;
    now?: string;
  }): Promise<void> {
    const now = input.now ?? nowIso();
    await this.skills.disableAgentSkillBinding({
      appId: input.appId,
      agentId: input.agentId,
      skillId: input.skillId,
      updatedAt: now,
    });
    const skill = await this.requireSkill(input.appId, input.skillId);
    if (skill.status !== 'approved') return;
    await this.skills.saveSkill({
      ...skill,
      status: 'draft',
      approvedBy: undefined,
      approvedAt: undefined,
      updatedAt: now,
    });
  }

  async resolveLocalSkillsForAgent(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<SkillCatalogItem[]> {
    const skills = await this.skills.listEnabledSkillsForAgent(input);
    return skills.filter(isSkillMaterializableLocally);
  }

  async requireSkill(
    appId: AppId,
    skillId: SkillId,
  ): Promise<SkillCatalogItem> {
    const skill = await this.skills.getSkill(skillId);
    if (!skill || skill.appId !== appId) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    return skill;
  }

  private async findExistingSkillByContentHash(input: {
    appId: AppId;
    agentId?: AgentId;
    contentHash: string;
  }): Promise<SkillCatalogItem | null> {
    const statuses: SkillStatus[] = [
      'draft',
      'approved',
      'rejected',
      'disabled',
    ];
    if (this.skills.getSkillByContentHash) {
      return this.skills.getSkillByContentHash({
        appId: input.appId,
        contentHash: input.contentHash,
        agentId: input.agentId ?? null,
        statuses,
      });
    }
    const existing = await this.skills.listSkills({
      appId: input.appId,
      statuses,
    });
    return (
      existing.find(
        (skill) =>
          skill.storage?.contentHash === input.contentHash &&
          (input.agentId
            ? skill.agentId === input.agentId
            : skill.agentId === undefined),
      ) ?? null
    );
  }
}

function resolveSkillMetadata(input: {
  assets: Array<{
    path: string;
    content: Uint8Array;
  }>;
  name?: string;
  description?: string;
  fallbackName?: string;
  requiredEnvVars?: string[];
}): { name: string; description?: string; requiredEnvVars: string[] } {
  const skillMd = input.assets.find((asset) => asset.path === 'SKILL.md');
  const frontmatter = skillMd
    ? parseSkillFrontmatter(Buffer.from(skillMd.content).toString('utf-8'))
    : {};
  const name =
    cleanMetadataText(input.name) ||
    cleanMetadataText(frontmatter.name) ||
    cleanMetadataText(input.fallbackName) ||
    'uploaded-skill';
  const description =
    cleanMetadataText(input.description) ||
    cleanMetadataText(frontmatter.description);
  return {
    name,
    description,
    requiredEnvVars: normalizeRequiredEnvVars([
      ...(input.requiredEnvVars ?? []),
      ...frontmatterEnvVars(frontmatter),
    ]),
  };
}

function frontmatterEnvVars(frontmatter: Record<string, string>): string[] {
  return [
    frontmatter.required_env,
    frontmatter.required_env_vars,
    frontmatter.env,
    frontmatter.env_vars,
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/[,\s]+/));
}

function normalizeRequiredEnvVars(values: string[]): string[] {
  const normalized = values
    .map(normalizeCapabilitySecretName)
    .filter((value) => value.length > 0);
  for (const name of normalized) assertValidCapabilitySecretName(name);
  return [...new Set(normalized)];
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return {};
  }
  const normalized = content.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return {};
  const lines = normalized.slice(4, end).split('\n');
  const metadata: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (rawValue === '|') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^\s{2}/, ''));
      }
      metadata[key] = block.join('\n').trim();
      continue;
    }
    metadata[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
  }
  return metadata;
}

function cleanMetadataText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
