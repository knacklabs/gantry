import { isUtf8 } from 'node:buffer';

import type {
  BrowserSkillAttachmentAgentResponse,
  BrowserSkillFileMetadataResponse,
  BrowserSkillResponse,
} from '@gantry/contracts';

import type { Agent } from '../../../domain/agent/agent.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
} from '../../../domain/skills/skills.js';
import type { SkillArtifactAsset } from '../../../domain/ports/skill-artifact-store.js';

export function browserSkillResponse(
  skill: SkillCatalogItem,
  agents: readonly Agent[],
  bindings: readonly AgentSkillBinding[],
): BrowserSkillResponse {
  const attachedAgentIds = new Set(
    bindings
      .filter(
        (binding) =>
          binding.skillId === skill.id && binding.status === 'active',
      )
      .map((binding) => binding.agentId),
  );
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? null,
    source: skill.source,
    status: skill.status,
    sizeBytes: skill.storage?.sizeBytes ?? 0,
    actions: (skill.actionPermissions ?? []).map((action) => ({
      id: action.id,
      capabilityId: action.capabilityId,
      displayName: action.displayName,
      risk: action.risk,
      can: action.can,
      cannot: action.cannot,
      networkHosts: action.networkHosts ?? [],
      requiredCredentialNames: action.requiredEnvVars ?? [],
    })),
    attachedAgents: agents
      .filter((agent) => attachedAgentIds.has(agent.id))
      .map(({ id, name, status }) => ({ id, name, status })),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

export function browserSkillAttachmentAgents(
  agents: readonly Agent[],
  skillId: SkillCatalogItem['id'],
  bindings: readonly AgentSkillBinding[],
): BrowserSkillAttachmentAgentResponse[] {
  const attachedAgentIds = new Set(
    bindings
      .filter(
        (binding) => binding.skillId === skillId && binding.status === 'active',
      )
      .map((binding) => binding.agentId),
  );
  return agents.map(({ id, name, status }) => ({
    id,
    name,
    status,
    attached: attachedAgentIds.has(id),
  }));
}

export function browserSkillFileMetadata(
  asset: SkillArtifactAsset,
): BrowserSkillFileMetadataResponse {
  const content = Buffer.from(asset.content);
  return {
    path: asset.path,
    contentType: asset.contentType ?? null,
    sizeBytes: content.byteLength,
    isText: isUtf8(content),
  };
}

export function browserSkillFile(asset: SkillArtifactAsset) {
  const metadata = browserSkillFileMetadata(asset);
  return {
    ...metadata,
    content: metadata.isText
      ? new TextDecoder('utf-8', { fatal: true }).decode(asset.content)
      : null,
  };
}
