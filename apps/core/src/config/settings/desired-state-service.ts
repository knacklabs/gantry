import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import type {
  McpServerDefinition,
  McpServerId,
  McpServerVersion,
  McpServerVersionId,
} from '../../domain/mcp/mcp-servers.js';
import { assertNoRawSecretsInMcpConfig } from '../../domain/mcp/mcp-servers.js';
import type {
  AgentConversationBinding,
  ProviderConnection,
  ProviderConnectionId,
  ProviderId,
} from '../../domain/provider/provider.js';
import { replaceDesiredStateCapabilities } from './desired-state-capability-reconcile.js';
import { exportCurrentDesiredState } from './desired-state-current-export.js';
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
  loadSkillsById,
  memorySubjectForConfiguredBinding,
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
  RuntimeConfiguredAgentCapabilities,
  RuntimeConfiguredConversation,
  RuntimeProviderConnectionSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { resolveAgentToolReference } from '../../domain/tools/agent-tool-catalog-references.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  hashRuntimeMcpConfig,
  normalizeRuntimeMcpCredentialRefs,
  validateRuntimeConfiguredMcpServer,
} from './runtime-settings-mcp-desired-state.js';

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
      invalidReferences: [
        ...this.validateConfiguredGuardrails(settings),
        ...this.validateConfiguredMcpServers(settings),
        ...(await this.validateCapabilityReferences(settings)),
      ],
    };
  }

  async reconcile(settings: RuntimeSettings): Promise<SettingsReconcileResult> {
    const configuredReferenceErrors = [
      ...this.validateConfiguredGuardrails(settings),
      ...this.validateConfiguredMcpServers(settings),
    ];
    if (configuredReferenceErrors.length > 0) {
      return {
        applied: [],
        skipped: [],
        invalidReferences: configuredReferenceErrors,
      };
    }

    const applied: string[] = [];
    await this.reconcileConfiguredMcpServers(settings, applied);

    const invalidReferences = await this.validateCapabilityReferences(settings);
    if (invalidReferences.length > 0) {
      return { applied: [], skipped: [], invalidReferences };
    }

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
            binding.model || agent.persona || agent.guardrail
              ? {
                  model: binding.model,
                  persona: agent.persona,
                  guardrail: agent.guardrail,
                }
              : undefined,
          isTemplate: conversation?.isTemplate,
        });
        applied.push(`binding:${binding.jid}`);
      }

      if (
        settings.desiredState.authoritative ||
        hasAnyCapability(agent.capabilities)
      ) {
        await this.replaceCapabilities(agentId, agent.capabilities, now);
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
            toolIds: [],
            skillIds: [],
            mcpServerIds: [],
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

  private validateConfiguredMcpServers(settings: RuntimeSettings): string[] {
    const errors: string[] = [];
    for (const [serverId, server] of Object.entries(settings.mcpServers)) {
      try {
        assertNoRawSecretsInMcpConfig(server.config);
        validateRuntimeConfiguredMcpServer(server);
      } catch (error) {
        errors.push(
          `mcp_servers.${serverId} is invalid: ${errorMessage(error)}`,
        );
      }
    }
    return errors.sort();
  }

  private async reconcileConfiguredMcpServers(
    settings: RuntimeSettings,
    applied: string[],
  ): Promise<void> {
    for (const [serverId, server] of Object.entries(settings.mcpServers)) {
      const now = this.clock.now();
      const typedServerId = serverId as McpServerId;
      const existing =
        await this.deps.repositories.mcpServers.getServer(typedServerId);
      const credentialRefs = normalizeRuntimeMcpCredentialRefs(
        server.credentialRefs,
      );
      const configHash = hashRuntimeMcpConfig({
        config: server.config,
        allowedToolPatterns: server.allowedToolPatterns,
        autoApproveToolPatterns: server.autoApproveToolPatterns,
        credentialRefs,
        sandboxProfileId: server.sandboxProfileId,
      });
      const versionHash = configHash.slice(
        'sha256:'.length,
        'sha256:'.length + 12,
      );
      const versionId =
        `mcp-version:${serverId.slice('mcp:'.length)}:${versionHash}` as McpServerVersionId;

      // Look up existing versions for this server so we can:
      //  1. short-circuit when settings.yaml hasn't actually changed
      //     (configHash matches an existing version → reuse its row), and
      //  2. allocate the next version number when the config DID change
      //     (avoids violating the (server_id, version) unique constraint).
      // The mcp_server_versions schema was always built for version history
      // (see mcp-servers.ts: uniqueIndex on (server_id, version), listVersions
      // helper, latestApprovedVersionId pointer). This implementation finally
      // honors that design — every config edit produces a new version row,
      // bindings transparently re-point via latestApprovedVersionId on the
      // next capability reconcile, and the old version rows linger only as
      // history (harmless; restorable via latestApprovedVersionId rollback).
      const existingVersions =
        await this.deps.repositories.mcpServers.listVersions(typedServerId);
      const matchingByHash = existingVersions.find(
        (v) => v.configHash === configHash,
      );
      const versionNumber = matchingByHash
        ? matchingByHash.version
        : existingVersions.length === 0
          ? 1
          : Math.max(...existingVersions.map((v) => v.version)) + 1;
      const effectiveVersionId = matchingByHash ? matchingByHash.id : versionId;

      const definition: McpServerDefinition = {
        id: typedServerId,
        appId: this.appId,
        name: server.name,
        displayName: server.displayName,
        description: server.description,
        status: 'approved',
        createdSource: 'admin',
        riskClass: server.riskClass,
        latestApprovedVersionId: effectiveVersionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        approvedBy: existing?.approvedBy ?? 'settings.yaml',
        approvedAt: existing?.approvedAt ?? now,
      };
      const version: McpServerVersion = {
        id: effectiveVersionId,
        appId: this.appId,
        serverId: typedServerId,
        version: versionNumber,
        transport: server.config.transport,
        config: server.config,
        allowedToolPatterns: server.allowedToolPatterns,
        autoApproveToolPatterns: server.autoApproveToolPatterns,
        credentialRefs,
        sandboxProfileId: server.sandboxProfileId,
        configHash,
        reviewedBy: definition.approvedBy,
        reviewedAt: definition.approvedAt,
        createdAt: matchingByHash?.createdAt ?? now,
      };
      await this.deps.repositories.mcpServers.saveServer(definition);
      await this.deps.repositories.mcpServers.saveVersion(version);
      applied.push(`mcp_server:${server.name}`);
    }
  }

  private validateConfiguredGuardrails(settings: RuntimeSettings): string[] {
    const validator = this.deps.guardrailPolicies;
    if (!validator) return [];
    const supported = validator.registeredIds().join(', ') || '(none)';
    const errors: string[] = [];
    for (const [folder, agent] of Object.entries(settings.agents)) {
      const policy = agent.guardrail?.policy;
      if (policy && !validator.isRegistered(policy)) {
        errors.push(
          `agents.${folder}.guardrail.policy is invalid: supported policies are ${supported}`,
        );
      }
    }
    return errors;
  }

  async validateCapabilityReferences(
    settings: RuntimeSettings,
  ): Promise<string[]> {
    const errors: string[] = [];
    const skillIds = new Set<string>();
    const serverIds = new Set<string>();
    for (const agent of Object.values(settings.agents)) {
      for (const skillId of agent.capabilities.skillIds) skillIds.add(skillId);
      for (const serverId of agent.capabilities.mcpServerIds) {
        serverIds.add(serverId);
      }
    }
    const [skills, servers] = await Promise.all([
      loadSkillsById(this.deps.repositories.skills, [...skillIds]),
      loadMcpServersById(this.deps.repositories.mcpServers, [...serverIds]),
    ]);
    for (const [folder, agent] of Object.entries(settings.agents)) {
      for (const toolId of [...new Set(agent.capabilities.toolIds)]) {
        const resolved = await resolveAgentToolReference({
          repository: this.deps.repositories.tools,
          appId: this.appId,
          reference: toolId,
        });
        if (resolved.error) {
          errors.push(
            `agents.${folder}.capabilities.tool_ids contains unavailable tool ${toolId}: ${resolved.error}`,
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
        } else if (!skill.storage) {
          errors.push(
            `agents.${folder}.capabilities.skill_ids references skill without artifact storage: ${skillId}`,
          );
        }
      }
      for (const serverId of [...new Set(agent.capabilities.mcpServerIds)]) {
        if (settings.mcpServers[serverId]) continue;
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
  ): Promise<void> {
    await replaceDesiredStateCapabilities({
      appId: this.appId,
      agentId,
      capabilities,
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
