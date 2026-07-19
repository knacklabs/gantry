import type { AppId } from '../../domain/app/app.js';
import type { ProviderAccount } from '../../domain/provider/provider.js';
import {
  activeSources,
  readableActiveCapabilities,
} from '../../config/settings/desired-state-export-helpers.js';
import {
  folderForAgentId,
  groupByAgentId,
} from './desired-state-service-helpers.js';
import type { SettingsDesiredStateServiceDeps } from './desired-state-service-types.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeProviderAccountSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
} from '../../config/settings/runtime-settings-types.js';

export async function exportCurrentDesiredState(input: {
  deps: SettingsDesiredStateServiceDeps;
  appId: AppId;
  settings: RuntimeSettings;
}): Promise<RuntimeSettings> {
  const { deps, appId, settings } = input;
  const agents: Record<string, RuntimeConfiguredAgent> = {};
  const providers: Record<string, RuntimeProviderSettings> = {};
  const providerAccounts: Record<string, RuntimeProviderAccountSettings> = {};
  const storedAgents = await deps.repositories.agents.listAgents(appId);
  const activeStoredAgents = storedAgents.filter(
    (agent) => agent.status === 'active',
  );
  const agentIds = activeStoredAgents.map((agent) => agent.id);
  const [
    toolBindingRows,
    toolSourceRows,
    skillBindingRows,
    mcpBindingRows,
    toolCatalogRows,
    skillCatalogRows,
    storedProviderAccounts,
  ] = await Promise.all([
    deps.repositories.tools.listAgentToolBindingsForAgents({ appId, agentIds }),
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
    deps.repositories.tools.listTools({ appId, statuses: ['active'] }),
    deps.repositories.skills.listSkills({ appId, statuses: ['installed'] }),
    deps.repositories.providerAccounts?.listProviderAccounts
      ? deps.repositories.providerAccounts.listProviderAccounts(appId)
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
  const referencedProviderAccountIds = new Set(
    Object.values(settings.conversations).flatMap((conversation) => [
      conversation.providerAccount,
      ...Object.values(conversation.installedAgents).map(
        (install) => install.providerAccountId,
      ),
    ]),
  );

  for (const account of storedProviderAccounts.filter(
    (candidate) =>
      (!isInternalAppControlProviderAccount(candidate) ||
        referencedProviderAccountIds.has(String(candidate.id))) &&
      !isCanonicalFallbackProviderAccount(candidate),
  )) {
    const providerId = String(account.providerId);
    const agentFolder =
      folderForAgentId(account.agentId) ?? String(account.agentId);
    const accountId = String(account.id);
    const storedSecretRefs = runtimeSecretRefsForAccount(account);
    providerAccounts[accountId] = {
      agentId: agentFolder,
      provider: providerId,
      label: account.label,
      status: account.status,
      runtimeSecretRefs: Object.keys(storedSecretRefs).length
        ? storedSecretRefs
        : (settings.providerAccounts[accountId]?.runtimeSecretRefs ?? {}),
      externalIdentityRef: account.externalIdentityRef,
      config: Object.fromEntries(
        Object.entries(account.config).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    };
    providers[providerId] = {
      enabled:
        providers[providerId]?.enabled === true || account.status === 'active',
    };
  }

  for (const accountId of referencedProviderAccountIds) {
    if (providerAccounts[accountId]) continue;
    const account = settings.providerAccounts[accountId];
    if (!account) continue;
    providerAccounts[accountId] = structuredClone(account);
    providers[account.provider] = {
      enabled:
        providers[account.provider]?.enabled === true ||
        account.status !== 'disabled',
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
      delegates: existing?.delegates ?? [],
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

  return {
    ...settings,
    providers,
    providerAccounts,
    conversations: structuredClone(settings.conversations),
    agents,
  };
}

function isInternalAppControlProviderAccount(
  account: ProviderAccount,
): boolean {
  const providerId = String(account.providerId);
  return providerId === 'app' || providerId === 'control-http';
}

function isCanonicalFallbackProviderAccount(account: ProviderAccount): boolean {
  const accountId = String(account.id);
  return (
    accountId.startsWith('channel-providerAccount:') ||
    accountId.startsWith('channel-providerConnection:')
  );
}

function runtimeSecretRefsForAccount(
  account: ProviderAccount,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(account.runtimeSecretRefs).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
}
