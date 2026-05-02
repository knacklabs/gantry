import { createHash } from 'node:crypto';

import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
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
import { emptyPermissionRules } from '../../shared/permission-rules.js';
import {
  activeConfiguredCapabilities,
  flattenPermissionRules,
  hasAnyConfiguredCapability,
  hasConfiguredPermissionRules,
} from './desired-state-capabilities.js';
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
  agentConfig?: { model?: string };
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
          permissionRules,
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
          this.deps.repositories.agents.listAgentPermissionRules({
            appId: this.appId,
            agentId,
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
          permissionRules,
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
        permissionRules,
      } = exported;
      const folder = group.folder;
      const existing = agents[folder];
      const provider = providerInfoForJid(jid);
      const providerId = provider?.id ?? 'app';
      const connectionId =
        providers[providerId]?.defaultConnection ?? `${providerId}_default`;
      providers[providerId] = {
        enabled: true,
        defaultConnection: connectionId,
      };
      providerConnections[connectionId] ??= {
        provider: providerId,
        label: provider?.label ?? providerId,
        runtimeSecretRefs: defaultRuntimeSecretRefs(providerId),
      };
      const conversationId = stableSettingsId(
        `${folder}_${providerId}`,
        conversations,
      );
      conversations[conversationId] ??= {
        providerConnection: connectionId,
        externalId: stripProviderPrefix(jid),
        kind: provider?.isGroupJid(jid) ? 'channel' : 'dm',
        displayName: group.name,
        senderPolicy: { allow: '*', mode: 'trigger' },
        controlApprovers: [],
      };
      const desiredBindingId = stableSettingsId(
        `${folder}_${conversationId}`,
        bindings,
      );
      bindings[desiredBindingId] ??= {
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
          activeConfiguredCapabilities(
            toolBindings,
            skillBindings,
            mcpBindings,
            permissionRules,
          ),
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
        configuredJids.add(binding.jid);
        await this.deps.ops.setRegisteredGroup(binding.jid, {
          name: binding.name ?? agent.name,
          folder,
          trigger: binding.trigger,
          added_at: binding.addedAt,
          requiresTrigger: binding.requiresTrigger,
          isMain: binding.isMain,
          agentConfig: binding.model ? { model: binding.model } : undefined,
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
        hasAnyConfiguredCapability(agent.capabilities)
      ) {
        await this.replaceCapabilityBindings(agentId, agent.capabilities, now);
        applied.push(`capabilities:${folder}`);
      } else {
        skipped.push(`capabilities:${folder}:not-authoritative-empty`);
      }
      if (
        settings.desiredState.authoritative ||
        hasConfiguredPermissionRules(agent.capabilities)
      ) {
        await this.replacePermissionRules(agentId, agent.capabilities, now);
        applied.push(`permission_rules:${folder}`);
      } else {
        skipped.push(`permission_rules:${folder}:not-authoritative-empty`);
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
        const emptyCapabilities = {
          toolIds: [],
          skillIds: [],
          mcpServerIds: [],
          permissionRules: emptyPermissionRules(),
        };
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
        await this.replaceCapabilityBindings(agent.id, emptyCapabilities, now);
        await this.replacePermissionRules(agent.id, emptyCapabilities, now);
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

    const existing = await conversations.findConversationByExternalValue({
      appId: this.appId,
      externalConversationId,
    });
    if (existing) return existing;

    const conversation: Conversation = {
      id: `conversation:${jid}` as ConversationId,
      appId: this.appId,
      providerConnectionId: input.conversation
        .providerConnection as ProviderConnectionId,
      externalRef: {
        kind: 'conversation',
        value: externalConversationId,
      },
      kind: configuredConversationKind(
        input.conversation.kind,
        connectionSettings.provider,
      ),
      title: input.conversation.displayName,
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    };
    await conversations.saveConversation(conversation);
    return conversation;
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

  private async replaceCapabilityBindings(
    agentId: AgentId,
    capabilities: RuntimeConfiguredAgentCapabilities,
    now: string,
  ): Promise<void> {
    const mcpServersById = await this.getApprovedMcpServersById(
      capabilities.mcpServerIds,
    );
    await this.deps.repositories.agents.replaceAgentCapabilityBindings({
      appId: this.appId,
      agentId,
      toolBindings: capabilities.toolIds.map((toolId) => ({
        id: `agent-tool-binding:${agentId}:${toolId}` as never,
        appId: this.appId,
        agentId,
        toolId: toolId as never,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      })),
      skillBindings: capabilities.skillIds.map((skillId) => ({
        id: `agent-skill-binding:${agentId}:${skillId}` as never,
        appId: this.appId,
        agentId,
        skillId: skillId as never,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      })),
      mcpBindings: capabilities.mcpServerIds.map((serverId) => {
        const server = mcpServersById.get(serverId);
        return {
          id: `agent-mcp-binding:${agentId}:${serverId}` as never,
          appId: this.appId,
          agentId,
          serverId: serverId as never,
          versionId: server!.latestApprovedVersionId! as never,
          status: 'active' as const,
          required: false,
          permissionPolicyIds: [],
          createdAt: now,
          updatedAt: now,
        };
      }),
      updatedAt: now,
    });
  }

  private async replacePermissionRules(
    agentId: AgentId,
    capabilities: RuntimeConfiguredAgentCapabilities,
    now: string,
  ): Promise<void> {
    await this.deps.repositories.agents.replaceAgentPermissionRules({
      appId: this.appId,
      agentId,
      rules: flattenPermissionRules(capabilities.permissionRules),
      updatedAt: now,
    });
  }

  private async getApprovedMcpServersById(
    serverIds: readonly string[],
  ): Promise<Map<string, { latestApprovedVersionId?: string }>> {
    const servers = await this.loadMcpServersById([...new Set(serverIds)]);
    return new Map(
      [...servers.entries()]
        .filter(([, server]) => server)
        .map(([serverId, server]) => [
          serverId,
          { latestApprovedVersionId: server!.latestApprovedVersionId },
        ]),
    );
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

function mergeDmAccess(
  existing: RuntimeConfiguredAgent['dmAccess'],
  access: Array<{ provider: string; externalUserId: string }>,
  approvers: Array<{ provider: string; externalUserId: string }>,
): RuntimeConfiguredAgent['dmAccess'] {
  if (existing.length > 0) return existing;
  const providers = new Map<string, Set<string>>();
  for (const entry of access) {
    const set = providers.get(entry.provider) ?? new Set<string>();
    set.add(entry.externalUserId);
    providers.set(entry.provider, set);
  }
  return [...providers.entries()].map(([provider, userIds]) => ({
    provider,
    userIds: [...userIds].sort(),
    adminUserId: approvers.find((entry) => entry.provider === provider)
      ?.externalUserId,
  }));
}

function stableBindingId(
  jid: string,
  existing: Record<string, unknown>,
): string {
  const matching = Object.entries(existing).find(
    ([, binding]) =>
      binding &&
      typeof binding === 'object' &&
      'jid' in binding &&
      (binding as { jid?: unknown }).jid === jid,
  );
  if (matching) return matching[0];
  const base = jid.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 80) || 'primary';
  if (!Object.hasOwn(existing, base)) return base;
  const hash = createHash('sha256').update(jid).digest('hex').slice(0, 12);
  return `${base}_${hash}`.slice(0, 96);
}

function stableSettingsId(
  seed: string,
  existing: Record<string, unknown>,
): string {
  const base =
    seed
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'item';
  if (!Object.hasOwn(existing, base)) return base;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `${base}_${hash}`.slice(0, 96);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
