import { createHash } from 'node:crypto';

import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
} from '../../domain/skills/skills.js';
import type {
  AgentToolBinding,
  AgentToolSource,
} from '../../domain/tools/tools.js';
import type {
  RuntimeConfiguredAgentCapability,
  RuntimeConfiguredAgentSources,
  RuntimeConfiguredConversation,
} from './runtime-settings-types.js';
import { displayToolReference } from '../../shared/agent-tool-references.js';
import {
  containsGeneratedRuntimeSkillPath,
  GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON,
} from '../../shared/generated-runtime-paths.js';
import { semanticCapabilityFromToolCatalogItem } from '../../shared/semantic-capabilities.js';
import { normalizeConfiguredCapabilities } from './configured-capability-normalization.js';

export function activeCapabilities(
  toolBindings: AgentToolBinding[],
): RuntimeConfiguredAgentCapability[] {
  return toolBindings
    .filter((binding) => binding.status === 'active')
    .map((binding) => capabilityFromToolBinding(binding));
}

export function activeSources(
  skillBindings: AgentSkillBinding[],
  mcpBindings: AgentMcpServerBinding[],
  skillCatalogById: Map<unknown, { name: string }>,
  toolSources: AgentToolSource[] = [],
): RuntimeConfiguredAgentSources {
  return {
    skills: skillBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => {
        const skillId = binding.skillId;
        const skill = skillCatalogById.get(skillId);
        return {
          ...(skill ? { name: skill.name } : {}),
          id: String(skillId),
        };
      }),
    mcpServers: mcpBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => ({
        id: String(binding.serverId),
        ...(binding.allowedToolPatterns?.length
          ? { tools: [...binding.allowedToolPatterns] }
          : {}),
      })),
    tools: toolSources
      .filter((source) => source.status === 'active')
      .map((source) => ({
        id: source.sourceId,
        kind: source.kind,
        ...(source.version && source.version !== source.kind
          ? { version: source.version }
          : {}),
      })),
  };
}

export function readableActiveCapabilities(
  toolBindings: AgentToolBinding[],
  toolCatalogById: Map<unknown, { name: string; inputSchema?: unknown }>,
  _options: {
    skillBindings?: AgentSkillBinding[];
    skillCatalogById?: Map<unknown, SkillCatalogItem>;
  } = {},
): RuntimeConfiguredAgentCapability[] {
  const rawCapabilities = toolBindings
    .filter((item) => item.status === 'active')
    .map((binding) => {
      const tool = toolCatalogById.get(binding.toolId);
      const reference = tool
        ? displayToolReference({ toolId: binding.toolId, tool })
        : String(binding.toolId).replace(/^tool:/, '');
      if (containsGeneratedRuntimeSkillPath(reference)) {
        throw new Error(GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON);
      }
      return capabilityFromToolReference(reference, tool);
    });
  return normalizeConfiguredCapabilities({
    capabilities: rawCapabilities,
  }).capabilities;
}

function capabilityFromToolBinding(
  binding: AgentToolBinding,
): RuntimeConfiguredAgentCapability {
  return {
    id: String(binding.toolId).replace(/^tool:/, ''),
    version: 'builtin',
  };
}

function capabilityFromToolReference(
  reference: string,
  tool?: { name: string; inputSchema?: unknown },
): RuntimeConfiguredAgentCapability {
  if (reference === 'Browser') return { id: 'browser.use', version: 'builtin' };
  if (reference.startsWith('capability:')) {
    const semanticCapability = tool
      ? semanticCapabilityFromToolCatalogItem({
          name: tool.name,
          inputSchema: tool.inputSchema,
        })
      : undefined;
    return {
      id: reference.slice('capability:'.length),
      version: semanticCapability?.version ?? 'catalog',
    };
  }
  return { id: reference, version: 'builtin' };
}

export function configuredConversationId(input: {
  providerAccountId: string;
  externalId: string;
  conversations: Record<string, RuntimeConfiguredConversation>;
}): string | undefined {
  return rankedConversationMatches(input)[0];
}

function rankedConversationMatches(input: {
  providerAccountId: string;
  externalId: string;
  conversations: Record<string, RuntimeConfiguredConversation>;
}): string[] {
  return Object.entries(input.conversations)
    .filter(
      ([, conversation]) =>
        conversation.providerAccount === input.providerAccountId &&
        conversation.externalId === input.externalId,
    )
    .sort(([leftId, left], [rightId, right]) => {
      const score =
        conversationSettingsScore(right) - conversationSettingsScore(left);
      return score || leftId.localeCompare(rightId);
    })
    .map(([id]) => id);
}

function conversationSettingsScore(
  conversation: RuntimeConfiguredConversation,
): number {
  return conversation.controlApprovers.length > 0 ? 1 : 0;
}

export function stableSettingsId(
  seed: string,
  existing: Record<string, unknown>,
): string {
  const base =
    seed
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'item';
  if (!Object.hasOwn(existing, base)) return base;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `${base}_${hash}`.slice(0, 96);
}
