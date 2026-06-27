import type { AppId } from '../../domain/app/app.js';
import type { Conversation } from '../../domain/conversation/conversation.js';
import type {
  AgentConversationBinding,
  ProviderConnection,
} from '../../domain/provider/provider.js';
import {
  configuredBindingId,
  configuredConversationId,
  dedupeConfiguredConversation,
  activeSources,
  readableActiveCapabilities,
  stableBindingId,
  stableSettingsId,
} from './desired-state-export-helpers.js';
import {
  defaultRuntimeSecretRefs,
  providerInfoForJid,
  stripProviderPrefix,
} from './desired-state-provider-conversations.js';
import {
  agentIdForFolder,
  folderForAgentId,
  groupByAgentId,
  groupByConversationId,
  storedConversationKey,
} from './desired-state-service-helpers.js';
import type { SettingsDesiredStateServiceDeps } from './desired-state-service-types.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeProviderConnectionSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';

export async function exportCurrentDesiredState(input: {
  deps: SettingsDesiredStateServiceDeps;
  appId: AppId;
  settings: RuntimeSettings;
}): Promise<RuntimeSettings> {
  const { deps, appId, settings } = input;
  const groups = await deps.ops.getAllConversationRoutes();
  const agents: Record<string, RuntimeConfiguredAgent> = {};
  const providers: Record<string, RuntimeProviderSettings> = {};
  const providerConnections: Record<string, RuntimeProviderConnectionSettings> =
    {};
  const conversations: Record<string, RuntimeConfiguredConversation> = {};
  const bindings: Record<string, RuntimeConfiguredBinding> = {};

  const groupEntries = Object.entries(groups);
  const storedAgents = await deps.repositories.agents.listAgents(appId);
  const activeStoredAgents = storedAgents.filter(
    (agent) => agent.status === 'active',
  );
  const agentIds = [
    ...new Set([
      ...groupEntries.map(([, group]) => agentIdForFolder(group.folder)),
      ...activeStoredAgents.map((agent) => agent.id),
    ]),
  ];
  const [
    toolBindingRows,
    toolSourceRows,
    skillBindingRows,
    mcpBindingRows,
    toolCatalogRows,
    skillCatalogRows,
    storedProviderConnections,
    storedConversationBindings,
    storedConversations,
  ] = await Promise.all([
    deps.repositories.tools.listAgentToolBindingsForAgents({
      appId,
      agentIds,
    }),
    deps.repositories.tools.listAgentToolSourcesForAgents
      ? deps.repositories.tools.listAgentToolSourcesForAgents({
          appId,
          agentIds,
        })
      : Promise.resolve([]),
    deps.repositories.skills.listAgentSkillBindingsForAgents({
      appId,
      agentIds,
    }),
    deps.repositories.mcpServers.listAgentBindingsForAgents({
      appId,
      agentIds,
      limitPerAgent: 500,
    }),
    deps.repositories.tools.listTools({
      appId,
      statuses: ['active'],
    }),
    deps.repositories.skills.listSkills({
      appId,
      statuses: ['installed'],
    }),
    deps.repositories.providerConnections?.listProviderConnections
      ? deps.repositories.providerConnections.listProviderConnections(appId)
      : Promise.resolve([]),
    deps.repositories.providerConnections?.listAgentConversationBindings
      ? deps.repositories.providerConnections.listAgentConversationBindings(
          appId,
        )
      : Promise.resolve([]),
    deps.repositories.conversations
      ? deps.repositories.conversations.listConversations({ appId })
      : Promise.resolve([]),
  ]);
  const toolBindingsByAgent = groupByAgentId(toolBindingRows);
  const toolSourcesByAgent = groupByAgentId(toolSourceRows);
  const skillBindingsByAgent = groupByAgentId(skillBindingRows);
  const mcpBindingsByAgent = groupByAgentId(mcpBindingRows);
  const toolCatalogById = new Map(
    toolCatalogRows.map((tool) => [tool.id, tool]),
  );
  const skillCatalogById = new Map(
    skillCatalogRows.map((skill) => [skill.id, skill]),
  );
  const storedConversationsByExternal = new Map<string, Conversation>();
  for (const conversation of storedConversations) {
    const externalId = conversation.externalRef?.value?.trim();
    if (!externalId) continue;
    storedConversationsByExternal.set(
      storedConversationKey(conversation.providerConnectionId, externalId),
      conversation,
    );
  }
  const storedApproversByConversation = groupByConversationId(
    deps.repositories.conversations
      ? await deps.repositories.conversations.listConversationApproversForConversations(
          storedConversations.map((conversation) => conversation.id),
        )
      : [],
  );

  for (const connection of storedProviderConnections.filter(
    (connection) =>
      connection.status === 'active' &&
      !isInternalAppControlProviderConnection(connection),
  )) {
    const providerId = connection.providerId as string;
    const connectionId = connection.id as string;
    providerConnections[connectionId] = {
      provider: providerId,
      label: connection.label,
      runtimeSecretRefs: runtimeSecretRefsForConnection(connection),
    };
    const existingProvider = settings.providers[providerId];
    providers[providerId] = {
      enabled: true,
      defaultConnection:
        existingProvider?.defaultConnection &&
        providerConnections[existingProvider.defaultConnection]
          ? existingProvider.defaultConnection
          : (providers[providerId]?.defaultConnection ?? connectionId),
    };
  }

  for (const conversation of storedConversations.filter(
    (conversation) => conversation.status === 'active',
  )) {
    const providerConnectionId = conversation.providerConnectionId as string;
    const connection = providerConnections[providerConnectionId];
    if (!connection) continue;
    const externalId =
      conversation.externalRef?.value?.trim() ||
      String(conversation.id).replace(/^conversation:/, '');
    const conversationId =
      configuredConversationId({
        providerConnectionId,
        externalId,
        conversations: settings.conversations,
      }) ??
      stableSettingsId(
        `${connection.provider}_${externalId || conversation.id}`,
        conversations,
      );
    const existingConversation = settings.conversations[conversationId];
    const storedApprovers = (
      storedApproversByConversation.get(conversation.id) ?? []
    ).map((approver) => approver.externalUserId);
    conversations[conversationId] = {
      providerConnection: providerConnectionId,
      externalId,
      kind: conversation.kind,
      displayName:
        existingConversation?.displayName ??
        conversation.title ??
        externalId ??
        String(conversation.id),
      senderPolicy: existingConversation?.senderPolicy ?? {
        allow: '*',
        mode: 'trigger',
      },
      controlApprovers: [...new Set(storedApprovers)].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }

  for (const agent of activeStoredAgents) {
    const folder = folderForAgentId(agent.id);
    if (!folder) continue;
    const existing = settings.agents[folder];
    agents[folder] = {
      name: agent.name,
      folder,
      persona: existing?.persona ?? 'developer',
      relationshipMode: existing?.relationshipMode ?? 'personal',
      model: existing?.model,
      agentHarness: existing?.agentHarness,
      oneTimeJobDefaultModel: existing?.oneTimeJobDefaultModel,
      recurringJobDefaultModel: existing?.recurringJobDefaultModel,
      bindings: existing?.bindings ?? {},
      sources: activeSources(
        skillBindingsByAgent.get(agent.id) ?? [],
        mcpBindingsByAgent.get(agent.id) ?? [],
        skillCatalogById,
        toolSourcesByAgent.get(agent.id) ?? [],
      ),
      capabilities: readableActiveCapabilities(
        toolBindingsByAgent.get(agent.id) ?? [],
        toolCatalogById,
        {
          skillBindings: skillBindingsByAgent.get(agent.id) ?? [],
          skillCatalogById,
        },
      ),
      accessPreset: existing?.accessPreset ?? 'full',
    };
  }

  const storedConversationsById = new Map(
    storedConversations.map((conversation) => [conversation.id, conversation]),
  );
  for (const binding of storedConversationBindings.filter(
    (binding) => binding.status === 'active' && !binding.threadId,
  )) {
    const folder = folderForAgentId(binding.agentId);
    if (!folder) continue;
    const storedConversation = storedConversationsById.get(
      binding.conversationId,
    );
    if (!storedConversation) continue;
    const externalId =
      storedConversation.externalRef?.value?.trim() ||
      String(storedConversation.id).replace(/^conversation:/, '');
    const conversationId =
      configuredConversationId({
        providerConnectionId: binding.providerConnectionId as string,
        externalId,
        conversations,
      }) ??
      configuredConversationId({
        providerConnectionId: binding.providerConnectionId as string,
        externalId,
        conversations: settings.conversations,
      });
    if (!conversationId) continue;
    const existingBindingId = configuredBindingId({
      agent: folder,
      conversationId,
      bindings: settings.bindings,
    });
    const bindingId =
      existingBindingId ??
      stableSettingsId(`${folder}_${conversationId}`, bindings);
    const existingBinding = existingBindingId
      ? settings.bindings[existingBindingId]
      : undefined;
    bindings[bindingId] = {
      agent: folder,
      conversation: conversationId,
      trigger: nonEmptyTrigger(
        binding.triggerPattern,
        existingBinding?.trigger,
        defaultTriggerForExportedAgent(folder, agents[folder]),
      ),
      addedAt: binding.createdAt,
      requiresTrigger: binding.requiresTrigger,
      memoryScope: runtimeMemoryScope(binding.memoryScope),
      model: existingBinding?.model,
    };
  }

  const exportedGroups = groupEntries.map(([jid, group]) => {
    const agentId = agentIdForFolder(group.folder);
    return {
      jid,
      group,
      toolBindings: toolBindingsByAgent.get(agentId) ?? [],
      toolSources: toolSourcesByAgent.get(agentId) ?? [],
      skillBindings: skillBindingsByAgent.get(agentId) ?? [],
      mcpBindings: mcpBindingsByAgent.get(agentId) ?? [],
    };
  });

  for (const exported of exportedGroups) {
    const {
      jid,
      group,
      toolBindings,
      toolSources,
      skillBindings,
      mcpBindings,
    } = exported;
    const folder = group.folder;
    const existing = agents[folder] ?? settings.agents[folder];
    const provider = providerInfoForJid(jid);
    const providerId = provider?.id ?? 'app';
    const connectionId =
      providers[providerId]?.defaultConnection ??
      settings.providers[providerId]?.defaultConnection ??
      `${providerId}_default`;
    const externalId = stripProviderPrefix(jid);
    const kind = provider?.isGroupJid(jid) ? 'group' : 'dm';
    providers[providerId] = {
      enabled: true,
      defaultConnection: connectionId,
    };
    providerConnections[connectionId] ??= {
      provider: providerId,
      label: provider?.label ?? providerId,
      runtimeSecretRefs: defaultRuntimeSecretRefs(providerId),
    };
    const conversationId =
      configuredConversationId({
        providerConnectionId: connectionId,
        externalId,
        conversations,
      }) ??
      configuredConversationId({
        providerConnectionId: connectionId,
        externalId,
        conversations: settings.conversations,
      }) ??
      stableSettingsId(`${folder}_${providerId}`, conversations);
    const storedConversation =
      storedConversationsByExternal.get(
        storedConversationKey(connectionId, externalId),
      ) ?? null;
    const storedApprovers = !storedConversation
      ? []
      : (storedApproversByConversation.get(storedConversation.id) ?? []).map(
          (approver) => approver.externalUserId,
        );
    const existingConversation =
      conversations[conversationId] ?? settings.conversations[conversationId];
    const controlApprovers = existingConversation?.controlApprovers.length
      ? existingConversation.controlApprovers
      : storedApprovers;
    conversations[conversationId] = {
      providerConnection: connectionId,
      externalId,
      kind,
      displayName: existingConversation?.displayName ?? group.name,
      senderPolicy: existingConversation?.senderPolicy ?? {
        allow: '*',
        mode: 'trigger',
      },
      controlApprovers: [...new Set(controlApprovers)].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
    dedupeConfiguredConversation({
      canonicalId: conversationId,
      providerConnectionId: connectionId,
      externalId,
      conversations,
      bindings,
    });
    const desiredBindingId =
      configuredBindingId({
        agent: folder,
        conversationId,
        bindings,
      }) ?? stableSettingsId(`${folder}_${conversationId}`, bindings);
    bindings[desiredBindingId] = {
      agent: folder,
      conversation: conversationId,
      trigger: group.trigger,
      addedAt: group.added_at,
      requiresTrigger: group.requiresTrigger !== false,
      memoryScope: 'conversation',
      model: group.agentConfig?.model,
    };
    const bindingId = stableBindingId(jid, existing?.bindings ?? {});
    agents[folder] = {
      name: existing?.name ?? group.name,
      folder,
      persona: existing?.persona ?? group.agentConfig?.persona ?? 'developer',
      relationshipMode:
        existing?.relationshipMode ??
        group.agentConfig?.relationshipMode ??
        'personal',
      model: existing?.model ?? group.agentConfig?.model,
      agentHarness: existing?.agentHarness,
      oneTimeJobDefaultModel: existing?.oneTimeJobDefaultModel,
      recurringJobDefaultModel: existing?.recurringJobDefaultModel,
      bindings: {
        ...(existing?.bindings ?? {}),
        [bindingId]: {
          jid,
          name: group.name,
          trigger: group.trigger,
          addedAt: group.added_at,
          requiresTrigger: group.requiresTrigger !== false,
          model: group.agentConfig?.model,
        },
      },
      sources: activeSources(
        skillBindings,
        mcpBindings,
        skillCatalogById,
        toolSources,
      ),
      capabilities: readableActiveCapabilities(toolBindings, toolCatalogById, {
        skillBindings,
        skillCatalogById,
      }),
      accessPreset: existing?.accessPreset ?? 'full',
    };
  }

  return {
    ...settings,
    providers,
    providerConnections,
    conversations,
    bindings,
    agents,
  };
}

function isInternalAppControlProviderConnection(
  connection: ProviderConnection,
): boolean {
  const providerId = String(connection.providerId);
  return providerId === 'app' || providerId === 'control-http';
}

function runtimeSecretRefsForConnection(
  connection: ProviderConnection,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(connection.runtimeSecretRefs).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
}

function runtimeMemoryScope(
  value: AgentConversationBinding['memoryScope'],
): RuntimeConfiguredBinding['memoryScope'] {
  return value === 'app' ? 'agent' : value;
}

function nonEmptyTrigger(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return '@agent';
}

function defaultTriggerForExportedAgent(
  folder: string,
  agent?: RuntimeConfiguredAgent,
): string {
  return `@${(agent?.name || folder).trim() || 'agent'}`;
}
