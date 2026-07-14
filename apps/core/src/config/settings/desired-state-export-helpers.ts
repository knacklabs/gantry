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
  RuntimeConfiguredBinding,
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
      version: semanticCapability?.version ?? 'builtin',
    };
  }
  return { id: reference, version: 'builtin' };
}

export function configuredConversationId(input: {
  providerConnectionId: string;
  externalId: string;
  conversations: Record<string, RuntimeConfiguredConversation>;
}): string | undefined {
  return rankedConversationMatches(input)[0];
}

export function dedupeConfiguredConversation(input: {
  canonicalId: string;
  providerConnectionId: string;
  externalId: string;
  conversations: Record<string, RuntimeConfiguredConversation>;
  bindings: Record<string, RuntimeConfiguredBinding>;
}): void {
  const matches = rankedConversationMatches(input);
  const canonical = input.conversations[input.canonicalId];
  if (!canonical) return;
  for (const duplicateId of matches) {
    if (duplicateId === input.canonicalId) continue;
    const duplicate = input.conversations[duplicateId];
    if (!duplicate) continue;
    if (
      canonical.controlApprovers.length === 0 &&
      duplicate.controlApprovers.length > 0
    ) {
      canonical.controlApprovers = [...duplicate.controlApprovers];
    }
    for (const [bindingId, binding] of Object.entries(input.bindings)) {
      if (binding.conversation !== duplicateId) continue;
      const redundantBinding = Object.entries(input.bindings).some(
        ([candidateId, candidate]) =>
          candidateId !== bindingId &&
          candidate.agent === binding.agent &&
          candidate.conversation === input.canonicalId,
      );
      if (redundantBinding) {
        delete input.bindings[bindingId];
        continue;
      }
      input.bindings[bindingId] = {
        ...binding,
        conversation: input.canonicalId,
      };
    }
    delete input.conversations[duplicateId];
  }
}

function rankedConversationMatches(input: {
  providerConnectionId: string;
  externalId: string;
  conversations: Record<string, RuntimeConfiguredConversation>;
}): string[] {
  return Object.entries(input.conversations)
    .filter(
      ([, conversation]) =>
        (conversation.providerAccount ?? conversation.providerConnection) ===
          input.providerConnectionId &&
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

export function configuredBindingId(input: {
  agent: string;
  conversationId: string;
  bindings: Record<string, RuntimeConfiguredBinding>;
}): string | undefined {
  return Object.entries(input.bindings).find(
    ([, binding]) =>
      binding.agent === input.agent &&
      binding.conversation === input.conversationId,
  )?.[0];
}

export function stableBindingId(
  jid: string,
  existing: Record<string, unknown>,
): string {
  const matching = Object.entries(existing).find(
    ([, binding]) =>
      binding &&
      typeof binding === 'object' &&
      'jid' in binding &&
      (binding as { jid?: unknown }).jid === jid,
  );
  if (matching) return matching[0];
  const base = jid.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 80) || 'primary';
  if (!Object.hasOwn(existing, base)) return base;
  const hash = createHash('sha256').update(jid).digest('hex').slice(0, 12);
  return `${base}_${hash}`.slice(0, 96);
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
