import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import type {
  AgentConversationBinding,
  ProviderConnection,
  ProviderConnectionId,
  ProviderId,
} from '../../domain/provider/provider.js';
import { replaceDesiredStateCapabilities } from './desired-state-capability-reconcile.js';
import {
  activeCapabilities,
  configuredBindingId,
  configuredConversationId,
  dedupeConfiguredConversation,
  mergeDmAccess,
  stableBindingId,
  stableSettingsId,
} from './desired-state-export-helpers.js';
import {
  configuredConversationKind,
  defaultRuntimeSecretRefs,
  jidForConfiguredConversation,
  providerInfoForJid,
  stripProviderPrefix,
} from './desired-state-provider-conversations.js';
import {
  agentIdForFolder,
  configuredRoutingBindings,
  configuredRoutingBindingsByAgent,
  errorMessage,
  folderForAgentId,
  groupByAgentId,
  groupByConversationId,
  hasAnyCapability,
  loadMcpServersById,
  loadSkillsById,
  loadToolsById,
  memorySubjectForConfiguredBinding,
  storedConversationKey,
} from './desired-state-service-helpers.js';
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
  RuntimeConfiguredAgentCapabilities,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeProviderConnectionSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';

export class SettingsDesiredStateService {
  private readonly appId: AppId;
  private readonly clock: { now(): string };

  constructor(private readonly deps: SettingsDesiredStateServiceDeps) {
    this.appId = deps.appId ?? ('default' as AppId);
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
  }

  async exportCurrent(settings: RuntimeSettings): Promise<RuntimeSettings> {
    const groups = await this.deps.ops.getAllConversationRoutes();
    const agents: Record<string, RuntimeConfiguredAgent> = {
      ...settings.agents,
    };
    const providers: Record<string, RuntimeProviderSettings> = {
      ...settings.providers,
    };
    const providerConnections: Record<
      string,
      RuntimeProviderConnectionSettings
    > = {
      ...settings.providerConnections,
    };
    const conversations: Record<string, RuntimeConfiguredConversation> = {
      ...settings.conversations,
    };
    const bindings: Record<string, RuntimeConfiguredBinding> = {
      ...settings.bindings,
    };

    const groupEntries = Object.entries(groups);
    const agentIds = [
      ...new Set(
        groupEntries.map(([, group]) => agentIdForFolder(group.folder)),
      ),
    ];
    const [
      dmAccessRows,
      dmApproverRows,
      toolBindingRows,
      skillBindingRows,
      mcpBindingRows,
      storedConversations,
    ] = await Promise.all([
      this.deps.repositories.agents.listAgentDmAccessForAgents({
        appId: this.appId,
        agentIds,
      }),
      this.deps.repositories.agents.listAgentDmApproversForAgents({
        appId: this.appId,
        agentIds,
      }),
      this.deps.repositories.tools.listAgentToolBindingsForAgents({
        appId: this.appId,
        agentIds,
      }),
      this.deps.repositories.skills.listAgentSkillBindingsForAgents({
        appId: this.appId,
        agentIds,
      }),
      this.deps.repositories.mcpServers.listAgentBindingsForAgents({
        appId: this.appId,
        agentIds,
        limitPerAgent: 500,
      }),
      this.deps.repositories.conversations
        ? this.deps.repositories.conversations.listConversations({
            appId: this.appId,
          })
        : Promise.resolve([]),
    ]);
    const dmAccessByAgent = groupByAgentId(dmAccessRows);
    const dmApproversByAgent = groupByAgentId(dmApproverRows);
    const toolBindingsByAgent = groupByAgentId(toolBindingRows);
    const skillBindingsByAgent = groupByAgentId(skillBindingRows);
    const mcpBindingsByAgent = groupByAgentId(mcpBindingRows);
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
      this.deps.repositories.conversations
        ? await this.deps.repositories.conversations.listConversationApproversForConversations(
            storedConversations.map((conversation) => conversation.id),
          )
        : [],
    );

    const exportedGroups = groupEntries.map(([jid, group]) => {
      const agentId = agentIdForFolder(group.folder);
      return {
        jid,
        group,
        dmAccess: dmAccessByAgent.get(agentId) ?? [],
        dmApprovers: dmApproversByAgent.get(agentId) ?? [],
        toolBindings: toolBindingsByAgent.get(agentId) ?? [],
        skillBindings: skillBindingsByAgent.get(agentId) ?? [],
        mcpBindings: mcpBindingsByAgent.get(agentId) ?? [],
      };
    });

    for (const exported of exportedGroups) {
      const {
        jid,
        group,
        dmAccess,
        dmApprovers,
        toolBindings,
        skillBindings,
        mcpBindings,
      } = exported;
      const folder = group.folder;
      const existing = agents[folder];
      const provider = providerInfoForJid(jid);
      const providerId = provider?.id ?? 'app';
      const connectionId =
        providers[providerId]?.defaultConnection ?? `${providerId}_default`;
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
        }) ?? stableSettingsId(`${folder}_${providerId}`, conversations);
      const storedConversation =
        storedConversationsByExternal.get(
          storedConversationKey(connectionId, externalId),
        ) ?? null;
      const storedApprovers =
        kind === 'dm' || !storedConversation
          ? []
          : (
              storedApproversByConversation.get(storedConversation.id) ?? []
            ).map((approver) => approver.externalUserId);
      const existingConversation = conversations[conversationId];
      const controlApprovers =
        kind === 'dm'
          ? []
          : existingConversation?.controlApprovers.length
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
        isMain: group.isMain === true,
        memoryScope: 'conversation',
        model: group.agentConfig?.model,
      };
      const bindingId = stableBindingId(jid, existing?.bindings ?? {});
      agents[folder] = {
        name: existing?.name ?? group.name,
        folder,
        persona: existing?.persona ?? group.agentConfig?.persona ?? 'developer',
        model: existing?.model ?? group.agentConfig?.model,
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
            isMain: group.isMain === true,
            model: group.agentConfig?.model,
          },
        },
        dmAccess: mergeDmAccess(
          existing?.dmAccess ?? [],
          dmAccess.map((entry) => ({
            provider: entry.providerId,
            externalUserId: entry.externalUserId,
          })),
          dmApprovers.map((entry) => ({
            provider: entry.providerId,
            externalUserId: entry.externalUserId,
          })),
        ),
        capabilities:
          existing?.capabilities ??
          activeCapabilities(toolBindings, skillBindings, mcpBindings),
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

  async drift(
    settings: RuntimeSettings,
  ): Promise<SettingsDesiredStateDriftReport> {
    const groups = await this.deps.ops.getAllConversationRoutes();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set(
      configuredRoutingBindings(settings).map((binding) => binding.jid),
    );
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

      for (const binding of bindingsByAgent.get(folder) ?? []) {
        const conversation = binding.conversation;
        configuredJids.add(binding.jid);
        await this.deps.ops.setConversationRoute(binding.jid, {
          name: binding.name ?? agent.name,
          folder,
          trigger: binding.trigger,
          added_at: binding.addedAt,
          requiresTrigger: binding.requiresTrigger,
          isMain: binding.isMain,
          conversationKind:
            conversation?.kind === 'dm' || conversation?.kind === 'direct'
              ? 'dm'
              : 'channel',
          agentConfig:
            binding.model || agent.persona
              ? { model: binding.model, persona: agent.persona }
              : undefined,
        });
        applied.push(`binding:${binding.jid}`);
      }

      if (settings.desiredState.authoritative || agent.dmAccess.length > 0) {
        await this.deps.repositories.agents.replaceAgentDmAccessPolicy({
          appId: this.appId,
          agentId,
          accessEntries: agent.dmAccess.flatMap((entry) =>
            entry.userIds.map((externalUserId) => ({
              providerId: entry.provider,
              externalUserId,
            })),
          ),
          approverEntries: agent.dmAccess.flatMap((entry) =>
            entry.adminUserId
              ? [
                  {
                    providerId: entry.provider,
                    externalUserId: entry.adminUserId,
                  },
                ]
              : [],
          ),
          updatedAt: now,
        });
        applied.push(`dm_access:${folder}`);
      } else {
        skipped.push(`dm_access:${folder}:not-authoritative-empty`);
      }

      if (
        settings.desiredState.authoritative ||
        hasAnyCapability(agent.capabilities)
      ) {
        await this.replaceCapabilities(agentId, agent.capabilities, now, {
          preserveOpaqueSkillBindings: !settings.desiredState.authoritative,
        });
        applied.push(`capabilities:${folder}`);
      } else {
        skipped.push(`capabilities:${folder}:not-authoritative-empty`);
      }
    }

    if (
      this.deps.repositories.conversations &&
      this.deps.repositories.providerConnections
    ) {
      for (const [conversationKey, conversation] of Object.entries(
        settings.conversations,
      )) {
        const storedConversation = await this.ensureDesiredConversation({
          key: conversationKey,
          conversation,
          providerConnections: settings.providerConnections,
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
        await this.deps.repositories.agents.replaceAgentDmAccessPolicy({
          appId: this.appId,
          agentId: agent.id,
          accessEntries: [],
          approverEntries: [],
          updatedAt: now,
        });
        await this.replaceCapabilities(
          agent.id,
          { toolIds: [], skillIds: [], mcpServerIds: [] },
          now,
          { preserveOpaqueSkillBindings: false },
        );
        applied.push(`authoritative:disabled_absent_agent:${folder}`);
      }
    }

    return { applied, skipped, invalidReferences: [] };
  }

  private async ensureDesiredConversation(input: {
    key: string;
    conversation: RuntimeConfiguredConversation;
    providerConnections: Record<string, RuntimeProviderConnectionSettings>;
    now: string;
    skipped: string[];
  }): Promise<Conversation | null> {
    const conversations = this.deps.repositories.conversations;
    if (!conversations) return null;
    const connectionSettings =
      input.providerConnections[input.conversation.providerConnection];
    if (!connectionSettings) {
      input.skipped.push(
        `conversation:${input.key}:missing-provider-connection`,
      );
      return null;
    }
    const jid = jidForConfiguredConversation(
      input.conversation,
      input.providerConnections,
    );
    const externalConversationId = stripProviderPrefix(jid);

    if (this.deps.repositories.providerConnections) {
      await this.deps.repositories.providerConnections.saveProviderConnection({
        id: input.conversation.providerConnection as ProviderConnectionId,
        appId: this.appId,
        providerId: connectionSettings.provider as ProviderId,
        label: connectionSettings.label,
        status: 'active',
        config: {},
        runtimeSecretRefs: Object.values(connectionSettings.runtimeSecretRefs),
        createdAt: input.now,
        updatedAt: input.now,
      } satisfies ProviderConnection);
    }

    const providerId = connectionSettings.provider as ProviderId;
    const providerConnectionId = input.conversation
      .providerConnection as ProviderConnectionId;
    const existing = await this.findConfiguredConversation({
      conversations,
      providerId,
      providerConnectionId,
      externalConversationId,
    });
    const kind = configuredConversationKind(input.conversation.kind);
    if (existing) {
      if (
        existing.providerConnectionId === providerConnectionId &&
        existing.externalRef?.value === externalConversationId &&
        existing.kind === kind &&
        existing.title === input.conversation.displayName &&
        existing.status === 'active'
      ) {
        return existing;
      }
      const reconciled: Conversation = {
        ...existing,
        providerConnectionId,
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
      id: `conversation:${jid}` as ConversationId,
      appId: this.appId,
      providerConnectionId,
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
  }): Promise<void> {
    const providerConnections = this.deps.repositories.providerConnections;
    if (!providerConnections) return;
    for (const [bindingKey, binding] of Object.entries(
      input.settings.bindings,
    )) {
      if (binding.conversation !== input.conversationKey) continue;
      const agent = input.settings.agents[binding.agent];
      if (!agent) continue;
      const agentId = agentIdForFolder(binding.agent);
      await providerConnections.saveAgentConversationBinding({
        id: `agent-conversation-binding:${encodeURIComponent(
          binding.agent,
        )}:${encodeURIComponent(bindingKey)}` as AgentConversationBinding['id'],
        appId: this.appId,
        agentId,
        providerConnectionId: input.storedConversation.providerConnectionId,
        conversationId: input.storedConversation.id,
        displayName: input.conversation.displayName || agent.name,
        status: 'active',
        triggerMode: binding.requiresTrigger === false ? 'always' : 'keyword',
        triggerPattern: binding.trigger,
        requiresTrigger: binding.requiresTrigger,
        isAdminBinding: binding.isMain,
        memoryScope: binding.memoryScope,
        memorySubject: memorySubjectForConfiguredBinding({
          appId: this.appId,
          agentId,
          memoryScope: binding.memoryScope,
          conversation: input.conversation,
          conversationId: input.storedConversation.id,
        }),
        permissionPolicyIds: [],
        createdAt: binding.addedAt || input.now,
        updatedAt: input.now,
      } satisfies AgentConversationBinding);
    }
  }

  private async replaceStoredConversationApprovers(input: {
    conversation: Conversation;
    userIds: string[];
    updatedAt: string;
  }): Promise<void> {
    const conversations = this.deps.repositories.conversations;
    if (!conversations) return;
    if (input.conversation.kind === 'direct') {
      throw new Error(
        'Conversation approvers are not supported for direct conversations; use the agent DM admin for direct/private prompts',
      );
    }
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
          input.conversation.id,
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
    providerConnectionId: ProviderConnectionId;
    externalConversationId: string;
  }): Promise<Conversation | null> {
    return input.conversations.getConversationByExternalRef({
      appId: this.appId,
      providerId: input.providerId,
      providerConnectionId: input.providerConnectionId,
      externalConversationId: input.externalConversationId,
    });
  }

  async validateCapabilityReferences(
    settings: RuntimeSettings,
  ): Promise<string[]> {
    const errors: string[] = [];
    const toolIds = new Set<string>();
    const skillIds = new Set<string>();
    const serverIds = new Set<string>();
    for (const agent of Object.values(settings.agents)) {
      for (const toolId of agent.capabilities.toolIds) toolIds.add(toolId);
      for (const skillId of agent.capabilities.skillIds) skillIds.add(skillId);
      for (const serverId of agent.capabilities.mcpServerIds) {
        serverIds.add(serverId);
      }
    }
    const [tools, skills, servers] = await Promise.all([
      loadToolsById(this.deps.repositories.tools, [...toolIds]),
      loadSkillsById(this.deps.repositories.skills, [...skillIds]),
      loadMcpServersById(this.deps.repositories.mcpServers, [...serverIds]),
    ]);
    for (const [folder, agent] of Object.entries(settings.agents)) {
      for (const toolId of [...new Set(agent.capabilities.toolIds)]) {
        const tool = tools.get(toolId);
        if (
          !tool ||
          tool.appId !== this.appId ||
          tool.status !== 'active' ||
          !tool.selectable
        ) {
          errors.push(
            `agents.${folder}.capabilities.tool_ids contains unavailable tool: ${toolId}`,
          );
        }
      }
      for (const skillId of [...new Set(agent.capabilities.skillIds)]) {
        const skill = skills.get(skillId);
        if (
          !skill ||
          skill.appId !== this.appId ||
          skill.status !== 'approved'
        ) {
          errors.push(
            `agents.${folder}.capabilities.skill_ids contains unavailable skill: ${skillId}`,
          );
        } else if (!skill.storage && !skill.providerRef) {
          errors.push(
            `agents.${folder}.capabilities.skill_ids references skill without artifact/provider storage: ${skillId}`,
          );
        }
      }
      for (const serverId of [...new Set(agent.capabilities.mcpServerIds)]) {
        const server = servers.get(serverId);
        if (
          !server ||
          server.appId !== this.appId ||
          server.status !== 'approved' ||
          !server.latestApprovedVersionId
        ) {
          errors.push(
            `agents.${folder}.capabilities.mcp_server_ids contains unavailable MCP server: ${serverId}`,
          );
        }
      }
    }
    return errors.sort();
  }

  private async replaceCapabilities(
    agentId: AgentId,
    capabilities: RuntimeConfiguredAgentCapabilities,
    now: string,
    options: { preserveOpaqueSkillBindings?: boolean } = {},
  ): Promise<void> {
    await replaceDesiredStateCapabilities({
      appId: this.appId,
      agentId,
      capabilities,
      repositories: this.deps.repositories,
      now,
      preserveOpaqueSkillBindings: options.preserveOpaqueSkillBindings,
    });
  }
}

function normalizeUserIds(userIds: string[]): string[] {
  return [
    ...new Set(
      userIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function isValidExternalUserId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}
