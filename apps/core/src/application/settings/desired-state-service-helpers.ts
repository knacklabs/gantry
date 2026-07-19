import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import type { ProviderId } from '../../domain/provider/provider.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { normalizeRuntimeSecretRefString } from '../../domain/ports/runtime-secret-provider.js';
import {
  jidForConfiguredConversation,
  providerTopology,
} from '../../config/settings/desired-state-provider-conversations.js';
import type {
  ConfiguredRoutingBinding,
  SettingsChangeClassification,
  StoredAgentBinding,
} from './desired-state-service-types.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredConversation,
  RuntimeSettings,
} from '../../config/settings/runtime-settings-types.js';
import type { AgentConfig } from '../../domain/types.js';
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

export function configuredAgentConfig(
  binding: Pick<ConfiguredRoutingBinding, 'model' | 'permissionMode'>,
  agent?: Pick<RuntimeConfiguredAgent, 'persona' | 'relationshipMode'>,
): AgentConfig | undefined {
  const config: AgentConfig = {
    model: binding.model,
    permissionMode: binding.permissionMode,
    persona: agent?.persona,
    relationshipMode: agent?.relationshipMode,
  };
  return Object.values(config).some(Boolean) ? config : undefined;
}

export function configuredRoutingBindings(
  settings: RuntimeSettings,
): ConfiguredRoutingBinding[] {
  const routes: ConfiguredRoutingBinding[] = [];
  const installByRouteIdentity = new Map<string, string>();
  for (const [conversationId, conversation] of Object.entries(
    settings.conversations,
  )) {
    const jid = jidForConfiguredConversation(
      conversation,
      settings.providerAccounts,
    );
    for (const [installKey, install] of Object.entries(
      conversation.installedAgents,
    )) {
      if (install.status !== 'active' || !settings.agents[install.agentId]) {
        continue;
      }
      const providerAccountId =
        install.providerAccountId ?? conversation.providerAccount;
      const routeIdentity = JSON.stringify([
        install.agentId,
        providerAccountId ?? '',
        jid,
        install.threadId ?? '',
      ]);
      const installPath = `${conversationId}.${installKey}`;
      const existingInstallPath = installByRouteIdentity.get(routeIdentity);
      if (existingInstallPath) {
        throw new Error(
          `Duplicate active conversation installs ${existingInstallPath} and ${installPath} resolve to the same runtime route`,
        );
      }
      installByRouteIdentity.set(routeIdentity, installPath);
      routes.push({
        agentFolder: install.agentId,
        conversationId,
        jid,
        installKey,
        threadId: install.threadId,
        providerAccountId,
        name: conversation.displayName,
        trigger: install.trigger ?? '',
        addedAt: install.addedAt,
        requiresTrigger: conversation.requiresTrigger,
        memoryScope: install.memoryScope,
        model: install.model,
        permissionMode: install.permissionMode,
        conversation,
      });
    }
  }
  return routes.sort((left, right) =>
    `${left.agentFolder}:${left.providerAccountId ?? ''}:${left.jid}`.localeCompare(
      `${right.agentFolder}:${right.providerAccountId ?? ''}:${right.jid}`,
    ),
  );
}

export function memorySubjectForConfiguredBinding(input: {
  appId: AppId;
  agentId: AgentId;
  memoryScope: ConfiguredRoutingBinding['memoryScope'];
  conversation: RuntimeConfiguredConversation;
  conversationId: ConversationId;
}): MemorySubject {
  switch (input.memoryScope) {
    case 'app':
      return {
        kind: 'app',
        appId: input.appId,
      };
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

export function listDbOnlyGroupJids(input: {
  groups: Record<string, StoredAgentBinding>;
  chats: Array<{ jid: string; is_group?: number }>;
  configuredJids: Set<string>;
}): string[] {
  return [
    ...new Set([
      ...Object.keys(input.groups),
      ...input.chats
        .filter((chat) => chat.is_group === 1)
        .map((chat) => chat.jid),
    ]),
  ]
    .filter((jid) => !input.configuredJids.has(jid))
    .sort();
}

export function normalizeUserIds(userIds: string[]): string[] {
  return [
    ...new Set(
      userIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function isValidExternalUserId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}

export function isInternalProviderAccount(providerId: ProviderId): boolean {
  return providerId === 'app' || providerId === 'control-http';
}

export function normalizeRuntimeSecretRefs(input: {
  refs: Record<string, string>;
  pathPrefix: string;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input.refs).map(([key, value]) => [
      key,
      normalizeRuntimeSecretRefString(value, `${input.pathPrefix}.${key}`),
    ]),
  );
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
    !jsonEqual(before.conversations, after.conversations)
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
  // Tracing initializes once at boot from authoritative settings.
  if (!jsonEqual(before.observability, after.observability)) {
    restartRequired.push('observability');
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
