import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import type { ConversationApprover } from '../../domain/provider/provider.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import {
  jidForConfiguredConversation,
  providerTopology,
} from './desired-state-provider-conversations.js';
import type {
  ConfiguredRoutingBinding,
  SettingsChangeClassification,
} from './desired-state-service-types.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeSettings,
} from './runtime-settings-types.js';
export {
  agentIdForFolder,
  folderForAgentId,
} from '../../domain/agent/agent-folder-id.js';

export function configuredRoutingBindingsByAgent(
  settings: RuntimeSettings,
): Map<string, ConfiguredRoutingBinding[]> {
  const result = new Map<string, ConfiguredRoutingBinding[]>();
  for (const binding of configuredRoutingBindings(settings)) {
    const entries = result.get(binding.agentFolder) ?? [];
    entries.push(binding);
    result.set(binding.agentFolder, entries);
  }
  return result;
}

export function configuredRoutingBindings(
  settings: RuntimeSettings,
): ConfiguredRoutingBinding[] {
  const byAgentAndJid = new Map<string, ConfiguredRoutingBinding>();

  for (const [folder, agent] of Object.entries(settings.agents)) {
    for (const binding of Object.values(agent.bindings)) {
      byAgentAndJid.set(`${folder}\0${binding.jid}`, {
        agentFolder: folder,
        jid: binding.jid,
        name: binding.name,
        trigger: binding.trigger,
        addedAt: binding.addedAt,
        requiresTrigger: binding.requiresTrigger,
        model: binding.model,
        conversation: Object.values(settings.conversations).find(
          (candidate) =>
            jidForConfiguredConversation(
              candidate,
              settings.providerConnections,
            ) === binding.jid,
        ),
      });
    }
  }

  for (const binding of Object.values(settings.bindings)) {
    if (!settings.agents[binding.agent]) continue;
    const conversation = settings.conversations[binding.conversation];
    if (!conversation) continue;
    const jid = jidForConfiguredConversation(
      conversation,
      settings.providerConnections,
    );
    byAgentAndJid.set(`${binding.agent}\0${jid}`, {
      agentFolder: binding.agent,
      jid,
      name: conversation.displayName,
      trigger: binding.trigger,
      addedAt: binding.addedAt,
      requiresTrigger: binding.requiresTrigger,
      model: binding.model,
      conversation,
    });
  }

  return [...byAgentAndJid.values()].sort((left, right) =>
    `${left.agentFolder}:${left.jid}`.localeCompare(
      `${right.agentFolder}:${right.jid}`,
    ),
  );
}

export function memorySubjectForConfiguredBinding(input: {
  appId: AppId;
  agentId: AgentId;
  memoryScope: RuntimeConfiguredBinding['memoryScope'];
  conversation: RuntimeConfiguredConversation;
  conversationId: ConversationId;
}): MemorySubject {
  switch (input.memoryScope) {
    case 'agent':
      return {
        kind: 'agent',
        appId: input.appId,
        agentId: input.agentId,
      };
    case 'user':
      if (
        input.conversation.kind === 'dm' ||
        input.conversation.kind === 'direct'
      ) {
        return {
          kind: 'user',
          appId: input.appId,
          userId: input.conversation.externalId as UserId,
        };
      }
      return {
        kind: 'agent',
        appId: input.appId,
        agentId: input.agentId,
      };
    case 'conversation':
      return {
        kind: 'conversation',
        appId: input.appId,
        conversationId: input.conversationId,
      };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function classifySettingsChanges(
  before: RuntimeSettings,
  after: RuntimeSettings,
): SettingsChangeClassification {
  const liveApplied: string[] = [];
  const restartRequired: string[] = [];

  if (!jsonEqual(before.storage, after.storage)) {
    restartRequired.push('storage');
  }
  if (!jsonEqual(before.credentialBroker, after.credentialBroker)) {
    restartRequired.push('model_access');
  }
  const providerTopologyChanged = !jsonEqual(
    providerTopology(before),
    providerTopology(after),
  );
  if (providerTopologyChanged) {
    restartRequired.push('providers');
  }
  if (
    !providerTopologyChanged &&
    (!jsonEqual(before.conversations, after.conversations) ||
      !jsonEqual(before.bindings, after.bindings))
  ) {
    liveApplied.push('conversation_policies');
  }
  if (!jsonEqual(before.agent, after.agent)) {
    liveApplied.push('agent_defaults');
  }
  if (!jsonEqual(before.agents, after.agents)) {
    restartRequired.push('agents');
  }
  if (!jsonEqual(before.memory, after.memory)) {
    restartRequired.push('memory');
  }
  if (!jsonEqual(before.runtime, after.runtime)) {
    restartRequired.push('runtime');
  }

  return {
    liveApplied: [...new Set(liveApplied)].sort(),
    restartRequired: [...new Set(restartRequired)].sort(),
  };
}

export function hasAnyCapability(agent: RuntimeConfiguredAgent) {
  return (
    agent.capabilities.length > 0 ||
    agent.sources.skills.length > 0 ||
    agent.sources.mcpServers.length > 0 ||
    agent.sources.tools.length > 0
  );
}

export function groupByAgentId<T extends { agentId: AgentId }>(
  rows: readonly T[],
): Map<AgentId, T[]> {
  const result = new Map<AgentId, T[]>();
  for (const row of rows) {
    const existing = result.get(row.agentId);
    if (existing) {
      existing.push(row);
    } else {
      result.set(row.agentId, [row]);
    }
  }
  return result;
}

export function groupByConversationId(
  rows: readonly ConversationApprover[],
): Map<ConversationId, ConversationApprover[]> {
  const result = new Map<ConversationId, ConversationApprover[]>();
  for (const row of rows) {
    const existing = result.get(row.conversationId);
    if (existing) {
      existing.push(row);
    } else {
      result.set(row.conversationId, [row]);
    }
  }
  return result;
}

export function storedConversationKey(
  providerConnectionId: string,
  externalConversationId: string,
): string {
  return `${providerConnectionId}\0${externalConversationId}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function loadToolsById(
  repository: ToolCatalogRepository,
  toolIds: readonly string[],
): Promise<Map<string, Awaited<ReturnType<ToolCatalogRepository['getTool']>>>> {
  const tools = await Promise.all(
    toolIds.map(
      async (toolId) =>
        [toolId, await repository.getTool(toolId as never)] as const,
    ),
  );
  return new Map(tools);
}

export async function loadMcpServersById(
  repository: McpServerRepository,
  serverIds: readonly string[],
): Promise<Map<string, Awaited<ReturnType<McpServerRepository['getServer']>>>> {
  const servers = await Promise.all(
    serverIds.map(
      async (serverId) =>
        [serverId, await repository.getServer(serverId as never)] as const,
    ),
  );
  return new Map(servers);
}
