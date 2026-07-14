import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import {
  canonicalConversationThreadId,
  type ConversationThread,
} from '../../domain/conversation/conversation.js';
import type {
  ConversationInstall,
  ProviderAccount,
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import {
  inlineAgentRuntimeCapabilityErrors,
  replaceDesiredStateCapabilities,
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
  configuredConversationKind,
  jidForConfiguredConversation,
  stripProviderPrefix,
} from './desired-state-provider-conversations.js';
import {
  agentIdForFolder,
  configuredAgentConfig,
  configuredRoutingBindings,
  configuredRoutingBindingsByAgent,
  errorMessage,
  folderForAgentId,
  hasAnyCapability,
  isInternalProviderAccount,
  isValidExternalUserId,
  loadMcpServersById,
  memorySubjectForConfiguredBinding,
  normalizeRuntimeSecretRefs,
  normalizeUserIds,
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
  RuntimeConfiguredConversation,
  RuntimeProviderAccountSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { resolveAgentToolReference } from '../../domain/tools/agent-tool-catalog-references.js';
import { nowIso } from '../../shared/time/datetime.js';
import { makeAgentThreadQueueKey } from '../../shared/thread-queue-key.js';

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
    const groups = await this.deps.ops.getAllConversationRoutes();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set<string>();
    for (const binding of configuredRoutingBindings(settings)) {
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
      dbOnlyGroupJids: Object.keys(groups)
        .filter((jid) => !configuredJids.has(jid))
        .sort(),
      invalidReferences: await this.validateCapabilityReferences(settings),
    };
  }

  async reconcile(settings: RuntimeSettings): Promise<SettingsReconcileResult> {
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
    const existingGroups = await this.deps.ops.getAllConversationRoutes();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set<string>();
    const bindingsByAgent = configuredRoutingBindingsByAgent(settings);
    const providerAccountEntries = Object.entries(settings.providerAccounts);

    for (const [folder, agent] of Object.entries(settings.agents)) {
      const agentId = agentIdForFolder(folder);
      const now = this.clock.now();
      await this.deps.repositories.agents.saveAgent({
        id: agentId,
        appId: this.appId,
        name: agent.name,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      applied.push(`agent:${folder}`);

      if (
        settings.desiredState.authoritative ||
        hasAnyCapability(agent) ||
        normalizedCapabilityFolders.has(folder)
      ) {
        await this.replaceCapabilities(agentId, agent, now);
        applied.push(`capabilities:${folder}`);
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

    if (
      this.deps.repositories.conversations &&
      this.deps.repositories.providerAccounts
    ) {
      for (const [conversationKey, conversation] of Object.entries(
        settings.conversations,
      )) {
        const storedConversation = await this.ensureDesiredConversation({
          key: conversationKey,
          conversation,
          providerAccounts: settings.providerAccounts,
          now: this.clock.now(),
          skipped,
        });
        if (!storedConversation) continue;
        await this.rebindConfiguredConversationBindings({
          settings,
          conversationKey,
          conversation,
          storedConversation,
          now: this.clock.now(),
          skipped,
        });
        try {
          await this.replaceStoredConversationApprovers({
            conversation: storedConversation,
            userIds: conversation.controlApprovers,
            updatedAt: this.clock.now(),
          });
          applied.push(`conversation_approvers:${conversationKey}`);
        } catch (err) {
          skipped.push(
            `conversation_approvers:${conversationKey}:${errorMessage(err)}`,
          );
        }
      }
    } else if (Object.keys(settings.conversations).length > 0) {
      skipped.push('conversation_approvers:missing-repositories');
    }

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
      const agents = await this.deps.repositories.agents.listAgents(this.appId);
      for (const agent of agents) {
        const folder = folderForAgentId(agent.id);
        if (!folder || configuredFolders.has(folder)) continue;
        const now = this.clock.now();
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
            bindings: {},
            sources: { skills: [], mcpServers: [], tools: [] },
            capabilities: [],
            accessPreset: 'full',
          },
          now,
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

  private async ensureDesiredConversation(input: {
    key: string;
    conversation: RuntimeConfiguredConversation;
    providerAccounts: Record<string, RuntimeProviderAccountSettings>;
    now: string;
    skipped: string[];
  }): Promise<Conversation | null> {
    const conversations = this.deps.repositories.conversations;
    if (!conversations) return null;
    const configuredProviderAccount =
      input.conversation.providerAccount ??
      input.conversation.providerConnection;
    const connectionSettings =
      input.providerAccounts[configuredProviderAccount];
    if (!connectionSettings) {
      input.skipped.push(
        `conversation:${input.key}:missing-provider-connection`,
      );
      return null;
    }
    const jid = jidForConfiguredConversation(
      input.conversation,
      input.providerAccounts,
    );
    const externalConversationId = stripProviderPrefix(jid);

    const providerId = connectionSettings.provider as ProviderId;
    const providerAccountId = configuredProviderAccount as ProviderAccountId;
    const existing = await this.findConfiguredConversation({
      conversations,
      providerId,
      providerAccountId,
      externalConversationId,
    });
    const kind = configuredConversationKind(input.conversation.kind);
    if (existing) {
      if (
        existing.providerAccountId === providerAccountId &&
        existing.externalRef?.value === externalConversationId &&
        existing.kind === kind &&
        existing.title === input.conversation.displayName &&
        existing.status === 'active'
      ) {
        return existing;
      }
      const reconciled: Conversation = {
        ...existing,
        providerAccountId,
        externalRef: {
          kind: 'conversation',
          value: externalConversationId,
        },
        kind,
        title: input.conversation.displayName,
        status: 'active',
        updatedAt: input.now,
      };
      await conversations.saveConversation(reconciled);
      return reconciled;
    }

    const conversation: Conversation = {
      id: `conversation:${providerAccountId}:${jid}` as ConversationId,
      appId: this.appId,
      providerAccountId,
      externalRef: {
        kind: 'conversation',
        value: externalConversationId,
      },
      kind,
      title: input.conversation.displayName,
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    };
    await conversations.saveConversation(conversation);
    return conversation;
  }

  private async rebindConfiguredConversationBindings(input: {
    settings: RuntimeSettings;
    conversationKey: string;
    conversation: RuntimeConfiguredConversation;
    storedConversation: Conversation;
    now: string;
    skipped: string[];
  }): Promise<void> {
    const providerAccounts = this.deps.repositories.providerAccounts;
    if (!providerAccounts) return;
    const desiredInstallIds = new Set<ConversationInstall['id']>();
    const installConversationIds = new Set<Conversation['id']>([
      input.storedConversation.id,
    ]);
    for (const [bindingKey, binding] of Object.entries(
      input.settings.bindings,
    )) {
      if (binding.conversation !== input.conversationKey) continue;
      const agent = input.settings.agents[binding.agent];
      if (!agent) continue;
      const agentId = agentIdForFolder(binding.agent);
      const install =
        input.conversation.installedAgents?.[binding.installKey ?? ''];
      const installProviderAccountId =
        install?.providerAccountId ??
        input.storedConversation.providerAccountId;
      const installConversation =
        installProviderAccountId === input.storedConversation.providerAccountId
          ? input.storedConversation
          : await this.ensureDesiredConversation({
              key: `${input.conversationKey}:${installProviderAccountId}`,
              conversation: {
                ...input.conversation,
                providerAccount: installProviderAccountId,
                providerConnection: installProviderAccountId,
              },
              providerAccounts: input.settings.providerAccounts,
              now: input.now,
              skipped: input.skipped,
            });
      if (!installConversation) continue;
      if (installConversation.id !== input.storedConversation.id) {
        await this.replaceStoredConversationApprovers({
          conversation: installConversation,
          participantSourceConversation: input.storedConversation,
          userIds: input.conversation.controlApprovers,
          updatedAt: input.now,
        });
      }
      const threadId = binding.threadId
        ? await this.ensureDesiredConversationThread({
            conversation: installConversation,
            publicThreadId: binding.threadId,
            now: input.now,
          })
        : undefined;
      const installId = `agent-conversation-binding:${encodeURIComponent(
        binding.agent,
      )}:${encodeURIComponent(bindingKey)}` as ConversationInstall['id'];
      desiredInstallIds.add(installId);
      installConversationIds.add(installConversation.id);
      await providerAccounts.saveConversationInstall({
        id: installId,
        appId: this.appId,
        agentId,
        providerAccountId: installProviderAccountId as ProviderAccountId,
        conversationId: installConversation.id,
        ...(threadId ? { threadId } : {}),
        displayName: input.conversation.displayName || agent.name,
        status: 'active',
        senderPolicy: 'provider_native',
        controlPolicy: 'conversation_approvers',
        memoryScope: binding.memoryScope,
        memorySubject: {
          ...memorySubjectForConfiguredBinding({
            appId: this.appId,
            agentId,
            memoryScope: binding.memoryScope,
            conversation: input.conversation,
            conversationId: installConversation.id,
          }),
          route: {
            trigger: binding.trigger,
            requiresTrigger: binding.requiresTrigger,
            agentConfig: configuredAgentConfig(binding),
          },
        },
        permissionPolicyIds: [],
        createdAt: binding.addedAt || input.now,
        updatedAt: input.now,
      } satisfies ConversationInstall);
    }
    for (const install of Object.values(
      input.conversation.installedAgents ?? {},
    )) {
      if (install.status !== 'disabled') continue;
      const installProviderAccountId =
        install.providerAccountId ?? input.storedConversation.providerAccountId;
      const installConversation =
        installProviderAccountId === input.storedConversation.providerAccountId
          ? input.storedConversation
          : await this.ensureDesiredConversation({
              key: `${input.conversationKey}:${installProviderAccountId}`,
              conversation: {
                ...input.conversation,
                providerAccount: installProviderAccountId,
                providerConnection: installProviderAccountId,
              },
              providerAccounts: input.settings.providerAccounts,
              now: input.now,
              skipped: input.skipped,
            });
      if (!installConversation) continue;
      installConversationIds.add(installConversation.id);
      const threadId = canonicalConversationThreadId({
        conversation: installConversation,
        threadId: install.threadId,
      });
      await providerAccounts.disableConversationInstall({
        appId: this.appId,
        agentId: agentIdForFolder(install.agentId),
        conversationId: installConversation.id,
        ...(threadId ? { threadId } : {}),
        updatedAt: input.now,
      });
    }
    if (!input.settings.desiredState.authoritative) return;
    for (const conversationId of installConversationIds) {
      const storedInstalls =
        await providerAccounts.listConversationInstallsByConversation({
          appId: this.appId,
          conversationId,
        });
      for (const install of storedInstalls) {
        if (install.status !== 'active') continue;
        if (desiredInstallIds.has(install.id)) continue;
        await providerAccounts.disableConversationInstall({
          appId: this.appId,
          agentId: install.agentId,
          conversationId: install.conversationId,
          ...(install.threadId ? { threadId: install.threadId } : {}),
          updatedAt: input.now,
        });
      }
    }
  }

  private async ensureDesiredConversationThread(input: {
    conversation: Conversation;
    publicThreadId: string;
    now: string;
  }): Promise<ConversationThread['id'] | undefined> {
    const threadId = canonicalConversationThreadId({
      conversation: input.conversation,
      threadId: input.publicThreadId,
    });
    if (!threadId) return undefined;
    await this.deps.repositories.conversations?.saveThread({
      id: threadId,
      appId: this.appId,
      conversationId: input.conversation.id,
      externalRef: {
        kind: 'conversation_thread',
        value: input.publicThreadId,
      },
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    });
    return threadId;
  }

  private async replaceStoredConversationApprovers(input: {
    conversation: Conversation;
    participantSourceConversation?: Conversation;
    userIds: string[];
    updatedAt: string;
  }): Promise<void> {
    const conversations = this.deps.repositories.conversations;
    if (!conversations) return;
    const userIds = normalizeUserIds(input.userIds);
    const invalidShape = userIds.filter((id) => !isValidExternalUserId(id));
    if (invalidShape.length > 0) {
      throw new Error(
        `Invalid control approver user ids: ${invalidShape.join(', ')}`,
      );
    }
    if (userIds.length > 0) {
      const knownMembers = new Set(
        await conversations.listParticipantExternalUserIds(
          input.participantSourceConversation?.id ?? input.conversation.id,
        ),
      );
      const invalidUserIds = userIds.filter((id) => !knownMembers.has(id));
      if (invalidUserIds.length > 0) {
        throw new Error(
          [
            'Control approvers must be members of the conversation.',
            `Invalid: ${invalidUserIds.join(', ')}`,
            knownMembers.size === 0
              ? 'No conversation participant records are available.'
              : undefined,
          ]
            .filter(Boolean)
            .join(' '),
        );
      }
    }
    await conversations.replaceConversationApprovers({
      appId: this.appId,
      conversationId: input.conversation.id,
      externalUserIds: userIds,
      updatedAt: input.updatedAt,
    });
  }

  private async findConfiguredConversation(input: {
    conversations: ConversationRepository;
    providerId: ProviderId;
    providerAccountId: ProviderAccountId;
    externalConversationId: string;
  }): Promise<Conversation | null> {
    return input.conversations.getConversationByExternalRef({
      appId: this.appId,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      externalConversationId: input.externalConversationId,
    });
  }

  async validateCapabilityReferences(
    settings: RuntimeSettings,
  ): Promise<string[]> {
    const errors: string[] = [];
    const serverIds = new Set<string>();
    for (const agent of Object.values(settings.agents)) {
      for (const source of agent.sources.mcpServers) {
        serverIds.add(source.id);
      }
    }
    const servers = await loadMcpServersById(
      this.deps.repositories.mcpServers,
      [...serverIds],
    );
    const catalogSemanticCapabilityDefinitions =
      semanticCapabilityDefinitionsFromCatalogTools(
        await this.deps.repositories.tools.listTools({
          appId: this.appId,
          statuses: ['active'],
        }),
      );
    errors.push(
      ...(await inlineAgentRuntimeCapabilityErrors({
        appId: this.appId,
        settings,
        repositories: this.deps.repositories,
        servers,
        catalogSemanticCapabilityDefinitions,
      })),
    );
    for (const [folder, agent] of Object.entries(settings.agents)) {
      const resolvedSkills = await resolveConfiguredSkillReferences({
        repository: this.deps.repositories.skills,
        appId: this.appId,
        agentId: agentIdForFolder(folder),
        references: agent.sources.skills.map((source) => source.id),
      });
      const [skillCollision] = skillMaterializationCollisions(
        selectedSkillsFromResolvedSkillReferences(
          agent.sources.skills.map((source) => source.id),
          resolvedSkills,
        ),
      );
      if (skillCollision) {
        errors.push(
          `agents.${folder}.sources.skills contains ${formatSkillMaterializationCollisionFragment(skillCollision)}`,
        );
      }
      const skillActionDefinitionsForAgent = skillActionDefinitionsForSkills([
        ...resolvedSkills.skills.values(),
      ]);
      const skillActionDefinitions = {
        ...catalogSemanticCapabilityDefinitions,
        ...semanticCapabilityDefinitionsById(skillActionDefinitionsForAgent),
      };
      const normalizedCapabilities = normalizeConfiguredCapabilities({
        capabilities: agent.capabilities,
      }).capabilities;
      for (const capability of [
        ...new Set(normalizedCapabilities.map((item) => item.id)),
      ]) {
        const toolReference = settingsCapabilityToToolReference({
          id: capability,
          version: 'builtin',
        });
        const resolved = await resolveAgentToolReference({
          repository: this.deps.repositories.tools,
          appId: this.appId,
          reference: toolReference,
          semanticCapabilityDefinitions: skillActionDefinitions,
        });
        if (resolved.error) {
          errors.push(
            `agents.${folder}.capabilities contains unavailable capability ${capability}: ${resolved.error}`,
          );
        }
      }
      for (const skillId of [
        ...new Set(agent.sources.skills.map((source) => source.id)),
      ]) {
        const skill = resolvedSkills.skills.get(skillId);
        const resolutionError = resolvedSkills.errors.get(skillId);
        if (!skill || resolutionError) {
          errors.push(
            `agents.${folder}.sources.skills contains ${resolutionError ?? `unavailable skill: ${skillId}`}`,
          );
        } else if (!skill.storage) {
          errors.push(
            `agents.${folder}.sources.skills references skill without artifact storage: ${skillId}`,
          );
        }
      }
      for (const serverId of [
        ...new Set(agent.sources.mcpServers.map((source) => source.id)),
      ]) {
        const server = servers.get(serverId);
        if (
          !server ||
          server.appId !== this.appId ||
          server.status !== 'active'
        ) {
          errors.push(
            `agents.${folder}.sources.mcp_servers contains unavailable MCP server: ${serverId}`,
          );
        }
      }
    }
    return errors.sort();
  }

  private async replaceCapabilities(
    agentId: AgentId,
    agent: RuntimeConfiguredAgent,
    now: string,
  ): Promise<void> {
    await replaceDesiredStateCapabilities({
      appId: this.appId,
      agentId,
      agent,
      repositories: this.deps.repositories,
      now,
    });
  }
}
