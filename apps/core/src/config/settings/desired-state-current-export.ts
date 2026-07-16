import type { AppId } from '../../domain/app/app.js';
import type { Conversation } from '../../domain/conversation/conversation.js';
import type { ProviderAccount } from '../../domain/provider/provider.js';
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
  RuntimeProviderAccountSettings,
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
  const providerAccounts: Record<string, RuntimeProviderAccountSettings> = {};
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
    storedProviderAccounts,
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
    deps.repositories.providerAccounts?.listProviderAccounts
      ? deps.repositories.providerAccounts.listProviderAccounts(appId)
      : Promise.resolve([]),
    deps.repositories.providerAccounts?.listConversationInstalls
      ? deps.repositories.providerAccounts.listConversationInstalls(appId)
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
      storedConversationKey(conversation.providerAccountId, externalId),
      conversation,
    );
  }
  const publicThreadIdsByCanonicalId = new Map<string, string>();
  if (typeof deps.repositories.conversations?.listThreads === 'function') {
    const storedThreads = await Promise.all(
      storedConversations.map((conversation) =>
        deps.repositories.conversations!.listThreads(conversation.id),
      ),
    );
    for (const thread of storedThreads.flat()) {
      const publicThreadId = thread.externalRef?.value?.trim();
      if (publicThreadId) {
        publicThreadIdsByCanonicalId.set(thread.id, publicThreadId);
      }
    }
  }
  const storedApproversByConversation = groupByConversationId(
    deps.repositories.conversations
      ? await deps.repositories.conversations.listConversationApproversForConversations(
          storedConversations.map((conversation) => conversation.id),
        )
      : [],
  );

  for (const connection of storedProviderAccounts.filter(
    (connection) => !isInternalAppControlProviderAccount(connection),
  )) {
    const providerId = connection.providerId as string;
    const agentFolder =
      folderForAgentId(connection.agentId) ?? String(connection.agentId);
    const connectionId = connection.id as string;
    providerAccounts[connectionId] = {
      agentId: agentFolder,
      provider: providerId,
      label: connection.label,
      status: connection.status,
      runtimeSecretRefs: runtimeSecretRefsForConnection(connection),
      externalIdentityRef: connection.externalIdentityRef,
      config: Object.fromEntries(
        Object.entries(connection.config).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    };
    providers[providerId] = {
      enabled:
        providers[providerId]?.enabled === true ||
        connection.status === 'active',
    };
  }

  for (const conversation of storedConversations.filter(
    (conversation) => conversation.status === 'active',
  )) {
    const providerAccountId = conversation.providerAccountId as string;
    const connection = providerAccounts[providerAccountId];
    if (!connection) continue;
    const externalId =
      conversation.externalRef?.value?.trim() ||
      String(conversation.id).replace(/^conversation:/, '');
    const conversationId =
      configuredConversationId({
        providerConnectionId: providerAccountId,
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
      providerConnection: providerAccountId,
      providerAccount: providerAccountId,
      externalId,
      kind: conversation.kind,
      displayName:
        existingConversation?.displayName ??
        conversation.title ??
        externalId ??
        String(conversation.id),
      brainHarvest: existingConversation?.brainHarvest ?? false,
      senderPolicy: existingConversation?.senderPolicy ?? {
        allow: '*',
        mode: 'trigger',
      },
      controlApprovers: [...new Set(storedApprovers)].sort((a, b) =>
        a.localeCompare(b),
      ),
      installedAgents: existingConversation?.installedAgents ?? {},
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
      permissionMode: existing?.permissionMode,
      runtime: existing?.runtime === 'inline' ? 'inline' : undefined,
      maxTurns: existing?.maxTurns,
      maxRunTokens: existing?.maxRunTokens,
      effort: existing?.effort,
      thinking: existing?.thinking,
      maxOutputTokens: existing?.maxOutputTokens,
      oneTimeJobDefaultModel: existing?.oneTimeJobDefaultModel,
      recurringJobDefaultModel: existing?.recurringJobDefaultModel,
      toolRules: existing?.toolRules,
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
    (binding) => binding.status === 'active',
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
        providerConnectionId: binding.providerAccountId as string,
        externalId,
        conversations,
      }) ??
      configuredConversationId({
        providerConnectionId: binding.providerAccountId as string,
        externalId,
        conversations: settings.conversations,
      });
    if (!conversationId) continue;
    const canonicalThreadId =
      typeof binding.threadId === 'string' && binding.threadId.trim()
        ? binding.threadId.trim()
        : undefined;
    const threadId = canonicalThreadId
      ? (publicThreadIdsByCanonicalId.get(canonicalThreadId) ??
        publicThreadIdFromCanonical({
          canonicalThreadId,
          providerAccountId: binding.providerAccountId as string,
          externalId,
        }))
      : undefined;
    const existingBindingId = threadId
      ? Object.entries(settings.bindings).find(
          ([, candidate]) =>
            candidate.agent === folder &&
            candidate.conversation === conversationId &&
            candidate.threadId === threadId,
        )?.[0]
      : configuredBindingId({
          agent: folder,
          conversationId,
          bindings: settings.bindings,
        });
    const bindingId =
      existingBindingId ??
      stableSettingsId(
        threadId
          ? `${folder}_${conversationId}_${threadId}`
          : `${folder}_${conversationId}`,
        bindings,
      );
    const existingBinding = existingBindingId
      ? settings.bindings[existingBindingId]
      : undefined;
    const route = binding.memorySubject?.route;
    const requiresTrigger =
      route?.requiresTrigger ??
      existingBinding?.requiresTrigger ??
      defaultRequiresTriggerForConversationKind(storedConversation.kind);
    const routeAgentConfig =
      route?.agentConfig &&
      typeof route.agentConfig === 'object' &&
      !Array.isArray(route.agentConfig)
        ? (route.agentConfig as {
            model?: unknown;
            permissionMode?: unknown;
          })
        : undefined;
    bindings[bindingId] = {
      agent: folder,
      conversation: conversationId,
      trigger: nonEmptyTrigger(route?.trigger ?? existingBinding?.trigger),
      addedAt: binding.createdAt,
      requiresTrigger,
      memoryScope: binding.memoryScope,
      model:
        typeof routeAgentConfig?.model === 'string'
          ? routeAgentConfig.model
          : existingBinding?.model,
      permissionMode:
        routeAgentConfig?.permissionMode === 'ask' ||
        routeAgentConfig?.permissionMode === 'auto'
          ? routeAgentConfig.permissionMode
          : existingBinding?.permissionMode,
    };
    conversations[conversationId].installedAgents[
      threadId ? `${folder}_${threadId}` : folder
    ] = {
      agentId: folder,
      providerAccountId: binding.providerAccountId as string,
      threadId,
      status: binding.status,
      addedAt: binding.createdAt,
      memoryScope: binding.memoryScope,
      trigger: bindings[bindingId].trigger,
      requiresTrigger,
      model: bindings[bindingId].model,
      permissionMode: bindings[bindingId].permissionMode,
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
    const groupProviderAccountId =
      typeof group.providerAccountId === 'string' &&
      group.providerAccountId.trim()
        ? group.providerAccountId.trim()
        : undefined;
    const connectionId =
      groupProviderAccountId ??
      Object.entries(providerAccounts).find(
        ([, account]) =>
          account.provider === providerId && account.agentId === folder,
      )?.[0] ??
      Object.entries(settings.providerAccounts).find(
        ([, account]) =>
          account.provider === providerId && account.agentId === folder,
      )?.[0] ??
      `${providerId}_default`;
    const externalId = stripProviderPrefix(jid);
    const kind = provider?.isGroupJid(jid) ? 'group' : 'dm';
    providers[providerId] = {
      enabled: true,
    };
    providerAccounts[connectionId] ??= {
      agentId: folder,
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
      providerAccount: connectionId,
      externalId,
      kind,
      displayName: existingConversation?.displayName ?? group.name,
      brainHarvest: existingConversation?.brainHarvest ?? false,
      senderPolicy: existingConversation?.senderPolicy ?? {
        allow: '*',
        mode: 'trigger',
      },
      controlApprovers: [...new Set(controlApprovers)].sort((a, b) =>
        a.localeCompare(b),
      ),
      installedAgents: existingConversation?.installedAgents ?? {},
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
      permissionMode: group.agentConfig?.permissionMode,
    };
    conversations[conversationId].installedAgents[folder] = {
      agentId: folder,
      providerAccountId: connectionId,
      status: 'active',
      addedAt: group.added_at,
      memoryScope: 'conversation',
      trigger: group.trigger,
      requiresTrigger: group.requiresTrigger !== false,
      model: group.agentConfig?.model,
      permissionMode: group.agentConfig?.permissionMode,
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
      permissionMode: existing?.permissionMode,
      runtime: existing?.runtime === 'inline' ? 'inline' : undefined,
      maxTurns: existing?.maxTurns,
      maxRunTokens: existing?.maxRunTokens,
      effort: existing?.effort,
      thinking: existing?.thinking,
      maxOutputTokens: existing?.maxOutputTokens,
      oneTimeJobDefaultModel: existing?.oneTimeJobDefaultModel,
      recurringJobDefaultModel: existing?.recurringJobDefaultModel,
      toolRules: existing?.toolRules,
      bindings: {
        ...(existing?.bindings ?? {}),
        [bindingId]: {
          jid,
          name: group.name,
          trigger: group.trigger,
          addedAt: group.added_at,
          requiresTrigger: group.requiresTrigger !== false,
          model: group.agentConfig?.model,
          permissionMode: group.agentConfig?.permissionMode,
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
    providerAccounts,
    conversations,
    bindings,
    agents,
  };
}

function isInternalAppControlProviderAccount(
  connection: ProviderAccount,
): boolean {
  const providerId = String(connection.providerId);
  return providerId === 'app' || providerId === 'control-http';
}

function runtimeSecretRefsForConnection(
  connection: ProviderAccount,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(connection.runtimeSecretRefs).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
}

function nonEmptyTrigger(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function publicThreadIdFromCanonical(input: {
  canonicalThreadId: string;
  providerAccountId: string;
  externalId: string;
}): string {
  const prefix = `thread:${input.providerAccountId}:${input.externalId}:`;
  return input.canonicalThreadId.startsWith(prefix)
    ? input.canonicalThreadId.slice(prefix.length)
    : input.canonicalThreadId;
}

function defaultRequiresTriggerForConversationKind(
  kind: Conversation['kind'],
): boolean {
  return kind !== 'direct';
}
