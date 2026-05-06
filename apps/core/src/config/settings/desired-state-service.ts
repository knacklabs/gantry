import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import type {
  AgentRepository,
  ConversationRepository,
  McpServerRepository,
  ProviderConnectionRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import type {
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
  providerTopology,
  stripProviderPrefix,
} from './desired-state-provider-conversations.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredAgentCapabilities,
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeProviderConnectionSettings,
  RuntimeProviderSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';

interface StoredAgentBinding {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  conversationKind?: 'dm' | 'channel';
  agentConfig?: { model?: string; persona?: AgentPersona };
}

export interface SettingsDesiredStateOps {
  getAllRegisteredGroups(): Promise<Record<string, StoredAgentBinding>>;
  setRegisteredGroup(jid: string, group: StoredAgentBinding): Promise<void>;
  deleteRegisteredGroup?(jid: string): Promise<void>;
}

export interface SettingsDesiredStateRepositories {
  agents: AgentRepository;
  providerConnections?: ProviderConnectionRepository;
  conversations?: ConversationRepository;
  tools: ToolCatalogRepository;
  skills: SkillCatalogRepository;
  mcpServers: McpServerRepository;
}

export interface SettingsDesiredStateServiceDeps {
  appId?: AppId;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  clock?: { now(): string };
}

export interface SettingsDesiredStateDriftReport {
  missingSettingsAgents: string[];
  dbOnlyGroupJids: string[];
  invalidReferences: string[];
}

export interface SettingsReconcileResult {
  applied: string[];
  skipped: string[];
  invalidReferences: string[];
}

export interface SettingsChangeClassification {
  liveApplied: string[];
  restartRequired: string[];
}

export class SettingsDesiredStateService {
  private readonly appId: AppId;
  private readonly clock: { now(): string };

  constructor(private readonly deps: SettingsDesiredStateServiceDeps) {
    this.appId = deps.appId ?? ('default' as AppId);
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
  }

  async exportCurrent(settings: RuntimeSettings): Promise<RuntimeSettings> {
    const groups = await this.deps.ops.getAllRegisteredGroups();
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

    const exportedGroups = await Promise.all(
      Object.entries(groups).map(async ([jid, group]) => {
        const agentId = agentIdForFolder(group.folder);
        const [
          dmAccess,
          dmApprovers,
          toolBindings,
          skillBindings,
          mcpBindings,
        ] = await Promise.all([
          this.deps.repositories.agents.listAgentDmAccess({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.agents.listAgentDmApprovers({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.tools.listAgentToolBindings({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.skills.listAgentSkillBindings({
            appId: this.appId,
            agentId,
          }),
          this.deps.repositories.mcpServers.listAgentBindings({
            appId: this.appId,
            agentId,
            limit: 500,
          }),
        ]);
        return {
          jid,
          group,
          dmAccess,
          dmApprovers,
          toolBindings,
          skillBindings,
          mcpBindings,
        };
      }),
    );

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
      const conversationsRepository = this.deps.repositories.conversations;
      const conversationId =
        configuredConversationId({
          providerConnectionId: connectionId,
          externalId,
          conversations,
        }) ?? stableSettingsId(`${folder}_${providerId}`, conversations);
      const storedConversation = conversationsRepository
        ? await this.findConfiguredConversation({
            conversations: conversationsRepository,
            providerId: providerId as ProviderId,
            providerConnectionId: connectionId as ProviderConnectionId,
            externalConversationId: externalId,
          })
        : null;
      const storedApprovers =
        kind === 'dm' || !storedConversation
          ? []
          : (
              await this.deps.repositories.conversations!.listConversationApprovers(
                storedConversation.id,
              )
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
    const groups = await this.deps.ops.getAllRegisteredGroups();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set(
      Object.values(settings.agents).flatMap((agent) =>
        Object.values(agent.bindings).map((binding) => binding.jid),
      ),
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
    const existingGroups = await this.deps.ops.getAllRegisteredGroups();
    const configuredFolders = new Set(Object.keys(settings.agents));
    const configuredJids = new Set<string>();

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

      for (const binding of Object.values(agent.bindings)) {
        const conversation = Object.values(settings.conversations).find(
          (candidate) =>
            jidForConfiguredConversation(
              candidate,
              settings.providerConnections,
            ) === binding.jid,
        );
        configuredJids.add(binding.jid);
        await this.deps.ops.setRegisteredGroup(binding.jid, {
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

    if (this.deps.repositories.conversations) {
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
        await this.deps.repositories.conversations.replaceConversationApprovers(
          {
            appId: this.appId,
            conversationId: storedConversation.id,
            externalUserIds: conversation.controlApprovers,
            updatedAt: this.clock.now(),
          },
        );
        applied.push(`conversation_approvers:${conversationKey}`);
      }
    }

    if (
      settings.desiredState.authoritative &&
      this.deps.ops.deleteRegisteredGroup
    ) {
      await Promise.all(
        Object.keys(existingGroups)
          .filter((jid) => !configuredJids.has(jid))
          .map((jid) => this.deps.ops.deleteRegisteredGroup!(jid)),
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
      this.loadToolsById([...toolIds]),
      this.loadSkillsById([...skillIds]),
      this.loadMcpServersById([...serverIds]),
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

  private async loadToolsById(
    toolIds: readonly string[],
  ): Promise<
    Map<string, Awaited<ReturnType<ToolCatalogRepository['getTool']>>>
  > {
    const tools = await Promise.all(
      toolIds.map(
        async (toolId) =>
          [
            toolId,
            await this.deps.repositories.tools.getTool(toolId as never),
          ] as const,
      ),
    );
    return new Map(tools);
  }

  private async loadSkillsById(
    skillIds: readonly string[],
  ): Promise<
    Map<string, Awaited<ReturnType<SkillCatalogRepository['getSkill']>>>
  > {
    const skills = await Promise.all(
      skillIds.map(
        async (skillId) =>
          [
            skillId,
            await this.deps.repositories.skills.getSkill(skillId as never),
          ] as const,
      ),
    );
    return new Map(skills);
  }

  private async loadMcpServersById(
    serverIds: readonly string[],
  ): Promise<
    Map<string, Awaited<ReturnType<McpServerRepository['getServer']>>>
  > {
    const servers = await Promise.all(
      serverIds.map(
        async (serverId) =>
          [
            serverId,
            await this.deps.repositories.mcpServers.getServer(
              serverId as never,
            ),
          ] as const,
      ),
    );
    return new Map(servers);
  }
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
    restartRequired.push('credential_broker');
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

  return {
    liveApplied: [...new Set(liveApplied)].sort(),
    restartRequired: [...new Set(restartRequired)].sort(),
  };
}

export function agentIdForFolder(folder: string): AgentId {
  return (folder.startsWith('agent:') ? folder : `agent:${folder}`) as AgentId;
}

function folderForAgentId(agentId: AgentId): string | null {
  const raw = String(agentId);
  return raw.startsWith('agent:') ? raw.slice('agent:'.length) : null;
}

function hasAnyCapability(capabilities: RuntimeConfiguredAgentCapabilities) {
  return (
    capabilities.toolIds.length > 0 ||
    capabilities.skillIds.length > 0 ||
    capabilities.mcpServerIds.length > 0
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
