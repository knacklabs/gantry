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
import {
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
  configuredRoutingBindings,
  configuredRoutingBindingsByAgent,
  errorMessage,
  folderForAgentId,
  hasAnyCapability,
  loadMcpServersById,
  memorySubjectForConfiguredBinding,
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
  RuntimeProviderConnectionSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { resolveAgentToolReference } from '../../domain/tools/agent-tool-catalog-references.js';
import { nowIso } from '../../shared/time/datetime.js';

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
          conversationKind:
            conversation?.kind === 'dm' || conversation?.kind === 'direct'
              ? 'dm'
              : 'channel',
          agentConfig:
            binding.model || agent.persona || agent.relationshipMode
              ? {
                  model: binding.model,
                  persona: agent.persona,
                  relationshipMode: agent.relationshipMode,
                }
              : undefined,
        });
        applied.push(`binding:${binding.jid}`);
      }

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
