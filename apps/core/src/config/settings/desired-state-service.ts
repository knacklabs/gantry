import type { Agent, AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpBindingAuthorityPrecondition } from '../../domain/mcp/mcp-servers.js';
import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import {
  buildDesiredStateCapabilityReplacement,
  inlineAgentRuntimeCapabilityErrors,
  replaceDesiredStateCapabilities,
  replaceDesiredStateToolSources,
  settingsCapabilityToToolReference,
} from './desired-state-capability-reconcile.js';
import { exportCurrentDesiredState } from './desired-state-current-export.js';
import {
  normalizeConfiguredCapabilities,
  normalizeConfiguredCapabilitiesInSettings,
  semanticCapabilityDefinitionsById,
  semanticCapabilityDefinitionsFromCatalogTools,
  skillActionDefinitionsForSkills,
} from './configured-capability-normalization.js';
import {
  agentIdForFolder,
  configuredAgentConfig,
  configuredRoutingBindings,
  configuredRoutingBindingsByAgent,
  folderForAgentId,
  hasAnyCapability,
  isInternalProviderAccount,
  listDbOnlyGroupJids,
  loadMcpServersById,
  normalizeRuntimeSecretRefs,
} from './desired-state-service-helpers.js';
import {
  resolveConfiguredSkillReferences,
  selectedSkillsFromResolvedSkillReferences,
} from './desired-state-skill-references.js';
import {
  formatSkillMaterializationCollisionFragment,
  skillMaterializationCollisions,
} from '../../domain/skills/skill-identity.js';
export {
  agentIdForFolder,
  classifySettingsChanges,
} from './desired-state-service-helpers.js';
export type {
  SettingsChangeClassification,
  SettingsDesiredStateDriftReport,
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
  SettingsDesiredStateServiceDeps,
  SettingsReconcileResult,
  StoredAgentBinding,
} from './desired-state-service-types.js';
import type {
  SettingsDesiredStateDriftReport,
  SettingsDesiredStateServiceDeps,
  SettingsReconcileResult,
} from './desired-state-service-types.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeProviderAccountSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { resolveAgentToolReference } from '../../domain/tools/agent-tool-catalog-references.js';
import { nowIso } from '../../shared/time/datetime.js';
import { makeAgentThreadQueueKey } from '../../shared/thread-queue-key.js';
import { validateDesiredStateCapabilityReferences } from './desired-state-capability-validation.js';
import { reconcileDesiredConversations } from './desired-state-conversation-reconcile.js';

export class SettingsDesiredStateService {
  private readonly appId: AppId;
  private readonly clock: { now(): string };

  constructor(private readonly deps: SettingsDesiredStateServiceDeps) {
    this.appId = deps.appId ?? ('default' as AppId);
    this.clock = deps.clock ?? { now: () => nowIso() };
  }

  async exportCurrent(settings: RuntimeSettings): Promise<RuntimeSettings> {
    return exportCurrentDesiredState({
      deps: this.deps,
      appId: this.appId,
      settings,
    });
  }

  async normalizeConfiguredCapabilities(settings: RuntimeSettings) {
    return normalizeConfiguredCapabilitiesInSettings({
      settings,
      repositories: this.deps.repositories,
      appId: this.appId,
    });
  }

  async drift(
    settings: RuntimeSettings,
  ): Promise<SettingsDesiredStateDriftReport> {
    settings = (await this.normalizeConfiguredCapabilities(settings)).settings;
    const [groups, chats] = await Promise.all([
      this.deps.ops.getAllConversationRoutes(),
      this.deps.ops.getAllChats?.() ?? Promise.resolve([]),
    ]);
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set<string>();
    for (const binding of configuredRoutingBindings(settings, groups)) {
      configuredJids.add(binding.jid);
      configuredJids.add(
        makeAgentThreadQueueKey(
          binding.jid,
          agentIdForFolder(binding.agentFolder),
          binding.threadId,
          binding.providerAccountId,
        ),
      );
    }
    return {
      missingSettingsAgents: [
        ...new Set(
          Object.values(groups)
            .map((group) => group.folder)
            .filter((folder) => !configuredFolders.has(folder)),
        ),
      ].sort(),
      dbOnlyGroupJids: listDbOnlyGroupJids({
        groups,
        chats,
        configuredJids,
      }),
      invalidReferences: await this.validateCapabilityReferences(settings),
    };
  }

  async reconcile(
    settings: RuntimeSettings,
    options: {
      expectedMcpBindingAgentIds?: AgentId[];
      expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    } = {},
  ): Promise<SettingsReconcileResult> {
    const normalization = await normalizeConfiguredCapabilitiesInSettings({
      settings,
      repositories: this.deps.repositories,
      appId: this.appId,
    });
    settings = normalization.settings;
    const normalizedCapabilityFolders = new Set(
      normalization.changedAgentFolders,
    );
    const invalidReferences = await this.validateCapabilityReferences(settings);
    if (invalidReferences.length > 0) {
      return { applied: [], skipped: [], invalidReferences };
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    const configuredFolders = new Set(Object.keys(settings.agents));
    const storedAgentsForAuthoritativeReconcile = settings.desiredState
      .authoritative
      ? await this.deps.repositories.agents.listAgents(this.appId)
      : [];
    const fencedCapabilityAgentIds = fencedCapabilityAgentIdsForBindings(
      options.expectedMcpBindingAgentIds,
      options.expectedMcpBindings,
    );
    const batchSavedAgentIds = new Set<AgentId>();
    const batchRemovedAgentIds = new Set<AgentId>();
    if (fencedCapabilityAgentIds.size > 0) {
      const replaceBatch =
        this.deps.repositories.agents.replaceAgentCapabilityBindingsBatch;
      if (!replaceBatch) {
        throw new Error(
          'Agent repository atomic MCP authority reconciliation is required for fenced settings revisions.',
        );
      }
      const fencedAgents = Object.entries(settings.agents).filter(
        ([folder, agent]) =>
          fencedCapabilityAgentIds.has(agentIdForFolder(folder)) &&
          (settings.desiredState.authoritative ||
            hasAnyCapability(agent) ||
            normalizedCapabilityFolders.has(folder)),
      );
      const replacements = [];
      const agents: Agent[] = [];
      for (const [folder, agent] of fencedAgents) {
        const agentId = agentIdForFolder(folder);
        const now = this.clock.now();
        agents.push({
          id: agentId,
          appId: this.appId,
          name: agent.name,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        batchSavedAgentIds.add(agentId);
        replacements.push(
          await buildDesiredStateCapabilityReplacement({
            appId: this.appId,
            agentId,
            agent,
            repositories: this.deps.repositories,
            now,
            authoritative: settings.desiredState.authoritative,
            expectedMcpBindings: (options.expectedMcpBindings ?? []).filter(
              (binding) => binding.agentId === agentId,
            ),
          }),
        );
      }
      if (settings.desiredState.authoritative) {
        for (const storedAgent of storedAgentsForAuthoritativeReconcile) {
          const folder = folderForAgentId(storedAgent.id);
          if (
            !folder ||
            configuredFolders.has(folder) ||
            !fencedCapabilityAgentIds.has(storedAgent.id)
          ) {
            continue;
          }
          const now = this.clock.now();
          agents.push({
            ...storedAgent,
            status: 'disabled',
            updatedAt: now,
          });
          replacements.push({
            appId: this.appId,
            agentId: storedAgent.id,
            toolBindings: [],
            skillBindings: [],
            mcpBindings: [],
            updatedAt: now,
          });
          batchSavedAgentIds.add(storedAgent.id);
          batchRemovedAgentIds.add(storedAgent.id);
        }
      }
      await replaceBatch.call(this.deps.repositories.agents, {
        appId: this.appId,
        agents,
        replacements,
        expectedMcpBindingAgentIds: [...fencedCapabilityAgentIds],
        expectedMcpBindings: options.expectedMcpBindings ?? [],
      });
      for (const [folder, agent] of fencedAgents) {
        await replaceDesiredStateToolSources({
          appId: this.appId,
          agentId: agentIdForFolder(folder),
          agent,
          repositories: this.deps.repositories,
          now: this.clock.now(),
        });
        applied.push(`capabilities:${folder}`);
      }
    }
    const existingGroups = await this.deps.ops.getAllConversationRoutes();
    const configuredJids = new Set<string>();
    const bindingsByAgent = configuredRoutingBindingsByAgent(
      settings,
      existingGroups,
    );
    const providerAccountEntries = Object.entries(settings.providerAccounts);

    for (const [folder, agent] of Object.entries(settings.agents)) {
      const agentId = agentIdForFolder(folder);
      const now = this.clock.now();
      if (!batchSavedAgentIds.has(agentId)) {
        await this.deps.repositories.agents.saveAgent({
          id: agentId,
          appId: this.appId,
          name: agent.name,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
      applied.push(`agent:${folder}`);

      if (
        settings.desiredState.authoritative ||
        hasAnyCapability(agent) ||
        normalizedCapabilityFolders.has(folder)
      ) {
        if (!fencedCapabilityAgentIds.has(agentId)) {
          await this.replaceCapabilities(
            agentId,
            agent,
            now,
            settings.desiredState.authoritative,
          );
          applied.push(`capabilities:${folder}`);
        }
      } else {
        skipped.push(`capabilities:${folder}:not-authoritative-empty`);
      }
    }

    if (this.deps.repositories.providerAccounts) {
      const desiredProviderAccountIds = new Set<string>();
      for (const [accountId, account] of providerAccountEntries) {
        desiredProviderAccountIds.add(accountId);
        await this.saveDesiredProviderAccount({
          accountId,
          account,
          status:
            settings.providers[account.provider]?.enabled === false
              ? 'disabled'
              : (account.status ?? 'active'),
          now: this.clock.now(),
        });
        applied.push(`provider_account:${accountId}`);
      }
      if (settings.desiredState.authoritative) {
        const storedProviderAccounts = this.deps.repositories.providerAccounts
          .listProviderAccounts
          ? await this.deps.repositories.providerAccounts.listProviderAccounts(
              this.appId,
            )
          : [];
        for (const connection of storedProviderAccounts) {
          if (
            connection.status !== 'active' ||
            desiredProviderAccountIds.has(connection.id) ||
            isInternalProviderAccount(connection.providerId)
          ) {
            continue;
          }
          await this.deps.repositories.providerAccounts.disableProviderAccount({
            appId: this.appId,
            id: connection.id,
            updatedAt: this.clock.now(),
          });
          applied.push(`provider_account:${connection.id}:disabled_absent`);
        }
      }
    } else if (providerAccountEntries.length > 0) {
      skipped.push('provider_accounts:missing-repository');
    }

    for (const [folder, agent] of Object.entries(settings.agents)) {
      for (const binding of bindingsByAgent.get(folder) ?? []) {
        const conversation = binding.conversation;
        const routeKey = makeAgentThreadQueueKey(
          binding.jid,
          agentIdForFolder(folder),
          binding.threadId,
          binding.providerAccountId,
        );
        configuredJids.add(routeKey);
        await this.deps.ops.setConversationRoute(routeKey, {
          name: agent.name,
          folder,
          conversationId: binding.conversationId,
          trigger: binding.trigger,
          added_at: binding.addedAt,
          requiresTrigger: binding.requiresTrigger,
          providerAccountId: binding.providerAccountId,
          conversationKind:
            conversation?.kind === 'dm' || conversation?.kind === 'direct'
              ? 'dm'
              : 'channel',
          agentConfig: configuredAgentConfig(binding, agent),
        });
        applied.push(`binding:${binding.jid}:${folder}`);
      }
    }

    await reconcileDesiredConversations({
      appId: this.appId,
      repositories: this.deps.repositories,
      settings,
      now: () => this.clock.now(),
      applied,
      skipped,
    });

    if (
      settings.desiredState.authoritative &&
      this.deps.ops.deleteConversationRoute
    ) {
      await Promise.all(
        Object.keys(existingGroups)
          .filter((jid) => !configuredJids.has(jid))
          .map((jid) => this.deps.ops.deleteConversationRoute!(jid)),
      );
      applied.push('authoritative:removed_absent_bindings');
    }

    if (settings.desiredState.authoritative) {
      for (const agent of storedAgentsForAuthoritativeReconcile) {
        const folder = folderForAgentId(agent.id);
        if (!folder || configuredFolders.has(folder)) continue;
        const now = this.clock.now();
        if (batchRemovedAgentIds.has(agent.id)) {
          await replaceDesiredStateToolSources({
            appId: this.appId,
            agentId: agent.id,
            agent: {
              name: agent.name,
              folder,
              delegates: [],
              bindings: {},
              sources: { skills: [], mcpServers: [], tools: [] },
              capabilities: [],
              accessPreset: 'full',
            },
            repositories: this.deps.repositories,
            now,
          });
          applied.push(`authoritative:disabled_absent_agent:${folder}`);
          continue;
        }
        await this.deps.repositories.agents.disableAgent({
          appId: this.appId,
          agentId: agent.id,
          updatedAt: now,
        });
        await this.replaceCapabilities(
          agent.id,
          {
            name: agent.name,
            folder,
            delegates: [],
            bindings: {},
            sources: { skills: [], mcpServers: [], tools: [] },
            capabilities: [],
            accessPreset: 'full',
          },
          now,
          true,
        );
        applied.push(`authoritative:disabled_absent_agent:${folder}`);
      }
    }

    return { applied, skipped, invalidReferences: [] };
  }

  private async saveDesiredProviderAccount(input: {
    accountId: string;
    account: RuntimeProviderAccountSettings;
    status: ProviderAccount['status'];
    now: string;
  }): Promise<void> {
    const providerAccounts = this.deps.repositories.providerAccounts;
    if (!providerAccounts) return;
    const id = input.accountId as ProviderAccountId;
    const providerId = input.account.provider as ProviderId;
    const existing = await providerAccounts.getProviderAccount(id);
    if (existing && existing.appId !== this.appId) {
      throw new Error(
        `provider_accounts.${input.accountId} already belongs to another app`,
      );
    }
    if (existing && existing.providerId !== providerId) {
      throw new Error(
        `provider_accounts.${input.accountId}.provider cannot change from ${existing.providerId} to ${providerId}; use a new provider account id.`,
      );
    }
    const existingForApp = existing ?? null;
    const agentId = input.account.agentId ?? existingForApp?.agentId;
    if (!agentId) {
      throw new Error(`provider_accounts.${input.accountId}.agent is required`);
    }
    await providerAccounts.saveProviderAccount({
      id,
      appId: this.appId,
      agentId: agentIdForFolder(agentId) as AgentId,
      providerId,
      externalIdentityRef:
        (input.account
          .externalIdentityRef as ProviderAccount['externalIdentityRef']) ??
        existingForApp?.externalIdentityRef,
      label: input.account.label,
      status: input.status,
      config: input.account.config ?? existingForApp?.config ?? {},
      runtimeSecretRefs: normalizeRuntimeSecretRefs({
        refs: input.account.runtimeSecretRefs,
        pathPrefix: `provider_accounts.${input.accountId}.runtime_secret_refs`,
      }),
      createdAt: existingForApp?.createdAt ?? input.now,
      updatedAt: input.now,
    } satisfies ProviderAccount);
  }

  async validateCapabilityReferences(
    settings: RuntimeSettings,
  ): Promise<string[]> {
    return validateDesiredStateCapabilityReferences({
      appId: this.appId,
      deps: this.deps,
      settings,
    });
  }

  private async replaceCapabilities(
    agentId: AgentId,
    agent: RuntimeConfiguredAgent,
    now: string,
    authoritative: boolean,
    expectedMcpBindingAgentIds?: AgentId[],
    expectedMcpBindings?: McpBindingAuthorityPrecondition[],
  ): Promise<void> {
    await replaceDesiredStateCapabilities({
      appId: this.appId,
      agentId,
      agent,
      repositories: this.deps.repositories,
      now,
      authoritative,
      expectedMcpBindingAgentIds,
      expectedMcpBindings,
    });
  }
}

function fencedCapabilityAgentIdsForBindings(
  expectedMcpBindingAgentIds: readonly AgentId[] | undefined,
  expectedMcpBindings: readonly McpBindingAuthorityPrecondition[] | undefined,
): Set<AgentId> {
  return new Set(
    expectedMcpBindingAgentIds ??
      (expectedMcpBindings ?? []).map((binding) => binding.agentId),
  );
}
