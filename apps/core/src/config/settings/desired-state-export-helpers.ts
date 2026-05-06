import { createHash } from 'node:crypto';

import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding } from '../../domain/skills/skills.js';
import type { AgentToolBinding } from '../../domain/tools/tools.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredAgentCapabilities,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
} from './runtime-settings-types.js';

export function activeCapabilities(
  toolBindings: AgentToolBinding[],
  skillBindings: AgentSkillBinding[],
  mcpBindings: AgentMcpServerBinding[],
): RuntimeConfiguredAgentCapabilities {
  return {
    toolIds: toolBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.toolId),
    skillIds: skillBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.skillId),
    mcpServerIds: mcpBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.serverId),
  };
}

export function mergeDmAccess(
  existing: RuntimeConfiguredAgent['dmAccess'],
  access: Array<{ provider: string; externalUserId: string }>,
  approvers: Array<{ provider: string; externalUserId: string }>,
): RuntimeConfiguredAgent['dmAccess'] {
  if (existing.length > 0) return existing;
  const providers = new Map<string, Set<string>>();
  for (const entry of access) {
    const set = providers.get(entry.provider) ?? new Set<string>();
    set.add(entry.externalUserId);
    providers.set(entry.provider, set);
  }
  return [...providers.entries()].map(([provider, userIds]) => ({
    provider,
    userIds: [...userIds].sort(),
    adminUserId: approvers.find((entry) => entry.provider === provider)
      ?.externalUserId,
  }));
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
        conversation.providerConnection === input.providerConnectionId &&
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
