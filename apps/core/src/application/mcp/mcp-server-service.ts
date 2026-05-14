import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpCredentialRef,
  McpServerDefinition,
  McpServerId,
  McpServerTransportConfig,
  McpServerVersion,
  McpServerVersionId,
} from '../../domain/mcp/mcp-servers.js';
import {
  assertNoRawSecretsInMcpConfig,
  assertValidMcpServerName,
  isMcpServerApproved,
  normalizeMcpServerName,
} from '../../domain/mcp/mcp-servers.js';
import type {
  AgentRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import { ApplicationError } from '../common/application-error.js';
import {
  RemoteMcpDnsValidationCache,
  assertRemoteMcpDestinationPublic,
  validateCredentialRefs,
  validateTransportConfig,
} from './mcp-server-policy.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import {
  materializeMcpRecord,
  type MaterializedMcpCapability,
} from './mcp-server-materialization.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';

export type { MaterializedMcpCapability } from './mcp-server-materialization.js';

export class McpServerService {
  constructor(
    private readonly mcpServers: McpServerRepository,
    private readonly agents?: AgentRepository,
    private readonly options: {
      lookupHostname?: HostnameLookup;
      dnsValidationCache?: RemoteMcpDnsValidationCache;
      auditMaterialization?: boolean;
    } = {},
  ) {}

  async createDraft(input: {
    appId: AppId;
    name: string;
    displayName?: string;
    description?: string;
    createdBy?: string;
    createdSource?: McpServerDefinition['createdSource'];
    requestedReason?: string;
    transportConfig: McpServerTransportConfig;
    allowedToolPatterns?: string[];
    autoApproveToolPatterns?: string[];
    credentialRefs?: McpCredentialRef[];
    sandboxProfileId?: string;
    riskClass?: McpServerDefinition['riskClass'];
  }): Promise<{ definition: McpServerDefinition; version: McpServerVersion }> {
    const name = normalizeMcpServerName(input.name);
    assertValidMcpServerName(name);
    validateTransportConfig(input.transportConfig, {
      sandboxProfileId: input.sandboxProfileId,
    });
    assertNoRawSecretsInMcpConfig(input.transportConfig);
    validateCredentialRefs(input.credentialRefs ?? []);
    validateToolPatternPolicy({
      allowedToolPatterns: input.allowedToolPatterns ?? [],
      autoApproveToolPatterns: input.autoApproveToolPatterns ?? [],
    });

    const existing = await this.mcpServers.getServerByName({
      appId: input.appId,
      name,
    });
    if (existing) {
      throw new ApplicationError(
        'CONFLICT',
        `MCP server already exists: ${name}`,
      );
    }

    const now = nowIso();
    const serverId = `mcp:${globalThis.crypto.randomUUID()}` as McpServerId;
    const definition: McpServerDefinition = {
      id: serverId,
      appId: input.appId,
      name,
      displayName: input.displayName,
      description: input.description,
      status: 'draft',
      createdSource: input.createdSource ?? 'admin',
      riskClass: input.riskClass ?? 'medium',
      requestedBy: input.createdBy,
      requestedReason: input.requestedReason,
      createdAt: now,
      updatedAt: now,
    };
    const version = buildVersion({
      appId: input.appId,
      serverId,
      version: 1,
      transportConfig: input.transportConfig,
      allowedToolPatterns: input.allowedToolPatterns ?? [],
      autoApproveToolPatterns: input.autoApproveToolPatterns ?? [],
      credentialRefs: input.credentialRefs ?? [],
      sandboxProfileId: input.sandboxProfileId,
    });
    await this.mcpServers.saveServer(definition);
    await this.mcpServers.saveVersion(version);
    await this.audit({
      appId: input.appId,
      serverId,
      versionId: version.id,
      eventType: 'request',
      actorId: input.createdBy,
      reason: input.requestedReason,
      metadata: { createdSource: definition.createdSource },
    });
    return { definition, version };
  }

  async listServers(input: {
    appId: AppId;
    statuses?: McpServerDefinition['status'][];
    limit?: number;
    cursor?: string;
  }): Promise<McpServerDefinition[]> {
    return this.mcpServers.listServers(input);
  }

  async approveDraft(input: {
    appId: AppId;
    serverId: McpServerId;
    approvedBy?: string;
  }): Promise<McpServerDefinition> {
    const server = await this.requireServer(input.appId, input.serverId);
    if (server.status !== 'draft') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Only draft MCP servers can be approved: ${server.id}`,
      );
    }
    const versions = await this.mcpServers.listVersions(server.id);
    const version = versions[0];
    if (!version) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server draft has no version: ${server.id}`,
      );
    }
    await assertRemoteMcpDestinationPublic(
      version.config,
      this.options.lookupHostname,
      { cache: this.options.dnsValidationCache },
    );
    const now = nowIso();
    const approved: McpServerDefinition = {
      ...server,
      status: 'approved',
      latestApprovedVersionId: version.id,
      approvedBy: input.approvedBy,
      approvedAt: now,
      updatedAt: now,
    };
    const reviewedVersion: McpServerVersion = {
      ...version,
      reviewedBy: input.approvedBy,
      reviewedAt: now,
    };
    const transitioned = await this.mcpServers.transitionServerStatus({
      appId: input.appId,
      serverId: server.id,
      expectedStatus: 'draft',
      next: approved,
    });
    if (!transitioned) {
      throw new ApplicationError(
        'CONFLICT',
        `MCP server draft changed before approval completed: ${server.id}`,
      );
    }
    await this.mcpServers.saveVersion(reviewedVersion);
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      versionId: version.id,
      eventType: 'approve',
      actorId: input.approvedBy,
    });
    return transitioned;
  }

  async rejectDraft(input: {
    appId: AppId;
    serverId: McpServerId;
    rejectedBy?: string;
    reason?: string;
  }): Promise<McpServerDefinition> {
    const server = await this.requireServer(input.appId, input.serverId);
    if (server.status !== 'draft') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Only draft MCP servers can be rejected: ${server.id}`,
      );
    }
    const now = nowIso();
    const rejected: McpServerDefinition = {
      ...server,
      status: 'rejected',
      rejectedBy: input.rejectedBy,
      rejectedAt: now,
      updatedAt: now,
    };
    const transitioned = await this.mcpServers.transitionServerStatus({
      appId: input.appId,
      serverId: server.id,
      expectedStatus: 'draft',
      next: rejected,
    });
    if (!transitioned) {
      throw new ApplicationError(
        'CONFLICT',
        `MCP server draft changed before rejection completed: ${server.id}`,
      );
    }
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      eventType: 'reject',
      actorId: input.rejectedBy,
      reason: input.reason,
    });
    return transitioned;
  }

  async disableServer(input: {
    appId: AppId;
    serverId: McpServerId;
    disabledBy?: string;
    reason?: string;
  }): Promise<McpServerDefinition> {
    const server = await this.requireServer(input.appId, input.serverId);
    if (!isMcpServerApproved(server)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Only approved MCP servers can be disabled: ${server.id}`,
      );
    }
    const now = nowIso();
    const disabled: McpServerDefinition = {
      ...server,
      status: 'disabled',
      disabledBy: input.disabledBy,
      disabledAt: now,
      updatedAt: now,
    };
    const transitioned = await this.mcpServers.transitionServerStatus({
      appId: input.appId,
      serverId: server.id,
      expectedStatus: 'approved',
      next: disabled,
    });
    if (!transitioned) {
      throw new ApplicationError(
        'CONFLICT',
        `MCP server changed before disable completed: ${server.id}`,
      );
    }
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      eventType: 'disable',
      actorId: input.disabledBy,
      reason: input.reason,
    });
    return transitioned;
  }

  async testServer(input: {
    appId: AppId;
    serverId: McpServerId;
    testedBy?: string;
  }): Promise<{ server: McpServerDefinition; ok: true; message: string }> {
    const server = await this.requireServer(input.appId, input.serverId);
    const version = server.latestApprovedVersionId
      ? await this.mcpServers.getVersion(server.latestApprovedVersionId)
      : null;
    if (!isMcpServerApproved(server) || !version) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server must be approved before testing: ${server.id}`,
      );
    }
    validateTransportConfig(version.config, {
      sandboxProfileId: version.sandboxProfileId,
    });
    await assertRemoteMcpDestinationPublic(
      version.config,
      this.options.lookupHostname,
      { cache: this.options.dnsValidationCache },
    );
    assertNoRawSecretsInMcpConfig(version.config);
    validateCredentialRefs(version.credentialRefs);
    await this.audit({
      appId: input.appId,
      serverId: server.id,
      versionId: version.id,
      eventType: 'test',
      actorId: input.testedBy,
      metadata: { transport: version.transport },
    });
    return {
      server,
      ok: true,
      message: 'MCP server definition is approved and safe to materialize.',
    };
  }

  async bindToAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    versionId?: McpServerVersionId;
    required?: boolean;
    permissionPolicyIds?: PermissionPolicyId[];
  }): Promise<AgentMcpServerBinding> {
    await this.assertAgentInApp(input.appId, input.agentId);
    const server = await this.requireServer(input.appId, input.serverId);
    if (!isMcpServerApproved(server)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server must be approved before binding: ${server.id}`,
      );
    }
    const versionId = input.versionId ?? server.latestApprovedVersionId;
    if (!versionId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server has no approved version: ${server.id}`,
      );
    }
    const version = await this.mcpServers.getVersion(versionId);
    if (
      !version ||
      version.appId !== input.appId ||
      version.serverId !== input.serverId
    ) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server version not found: ${versionId}`,
      );
    }
    const existingBinding = (
      await this.mcpServers.listAgentBindings({
        appId: input.appId,
        agentId: input.agentId,
        limit: 500,
      })
    ).find((binding) => binding.serverId === input.serverId);
    const latestServer = await this.requireServer(input.appId, input.serverId);
    if (!isMcpServerApproved(latestServer)) {
      throw new ApplicationError(
        'CONFLICT',
        `MCP server changed before binding completed: ${input.serverId}`,
      );
    }
    const now = nowIso();
    const binding: AgentMcpServerBinding = {
      id: `agent-mcp-binding:${input.agentId}:${input.serverId}` as AgentMcpServerBinding['id'],
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.serverId,
      versionId,
      status: 'active',
      required: input.required ?? false,
      permissionPolicyIds:
        input.permissionPolicyIds ?? existingBinding?.permissionPolicyIds ?? [],
      createdAt: existingBinding?.createdAt ?? now,
      updatedAt: now,
    };
    await this.mcpServers.saveAgentBinding(binding);
    await this.audit({
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.serverId,
      versionId,
      bindingId: binding.id,
      eventType: 'bind',
      metadata: {
        permissionPolicyIds: binding.permissionPolicyIds,
        preservedPermissionPolicies:
          !input.permissionPolicyIds && Boolean(existingBinding),
      },
    });
    return binding;
  }

  async unbindFromAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
  }): Promise<AgentMcpServerBinding | null> {
    await this.assertAgentInApp(input.appId, input.agentId);
    const binding = await this.mcpServers.disableAgentBinding({
      ...input,
      updatedAt: nowIso(),
    });
    if (binding) {
      await this.audit({
        appId: input.appId,
        agentId: input.agentId,
        serverId: input.serverId,
        versionId: binding.versionId,
        bindingId: binding.id,
        eventType: 'unbind',
      });
    }
    return binding;
  }

  async rollbackApprovedBinding(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
  }): Promise<void> {
    const now = nowIso();
    await this.mcpServers.disableAgentBinding({
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.serverId,
      updatedAt: now,
    });
    const server = await this.requireServer(input.appId, input.serverId);
    if (!isMcpServerApproved(server)) return;
    const versions = await this.mcpServers.listVersions(server.id);
    const version = server.latestApprovedVersionId
      ? versions.find((item) => item.id === server.latestApprovedVersionId)
      : undefined;
    const reverted: McpServerDefinition = {
      ...server,
      status: 'draft',
      latestApprovedVersionId: undefined,
      approvedBy: undefined,
      approvedAt: undefined,
      updatedAt: now,
    };
    await this.mcpServers.transitionServerStatus({
      appId: input.appId,
      serverId: server.id,
      expectedStatus: 'approved',
      next: reverted,
    });
    if (version) {
      await this.mcpServers.saveVersion({
        ...version,
        reviewedBy: undefined,
        reviewedAt: undefined,
      });
    }
    await this.audit({
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.serverId,
      versionId: version?.id,
      eventType: 'reject',
      reason: 'Rolled back approval after settings sync failure.',
    });
  }

  async listAgentBindings(input: {
    appId: AppId;
    agentId: AgentId;
    limit?: number;
    cursor?: string;
  }): Promise<AgentMcpServerBinding[]> {
    await this.assertAgentInApp(input.appId, input.agentId);
    return this.mcpServers.listAgentBindings(input);
  }

  async materializeForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverIds?: readonly McpServerId[];
    credentialEnv?: Record<string, string>;
  }): Promise<MaterializedMcpCapability[]> {
    if (input.serverIds && input.serverIds.length === 0) {
      return [];
    }
    const records =
      await this.mcpServers.listMaterializedServersForAgent(input);
    const settled = await Promise.allSettled(
      records.map((record) =>
        this.materializeOne(record, input.credentialEnv ?? {}),
      ),
    );
    const capabilities: MaterializedMcpCapability[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const record = records[index]!;
      if (result.status === 'fulfilled') {
        capabilities.push(result.value);
        continue;
      }
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      await this.audit({
        appId: input.appId,
        agentId: input.agentId,
        serverId: record.definition.id,
        versionId: record.version.id,
        bindingId: record.binding.id,
        eventType: 'startup_failure',
        reason,
        metadata: {
          name: record.definition.name,
          required: record.binding.required,
        },
      });
      if (
        result.reason instanceof ApplicationError &&
        /Missing broker credential/.test(result.reason.message)
      ) {
        throw result.reason;
      }
      if (record.binding.required) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Required MCP server failed to materialize: ${record.definition.name}: ${reason}`,
        );
      }
    }
    if (this.options.auditMaterialization ?? true) {
      const recordsByName = new Map(
        records.map((record) => [record.definition.name, record]),
      );
      for (const capability of capabilities) {
        const record = recordsByName.get(capability.name);
        await this.audit({
          appId: input.appId,
          agentId: input.agentId,
          serverId: record?.definition.id,
          versionId: record?.version.id,
          bindingId: record?.binding.id,
          eventType: 'materialize',
          metadata: { name: capability.name, required: capability.required },
        });
      }
    }
    return capabilities;
  }

  private async materializeOne(
    record: MaterializedMcpServer,
    credentialEnv: Record<string, string>,
  ): Promise<MaterializedMcpCapability> {
    await assertRemoteMcpDestinationPublic(
      record.version.config,
      this.options.lookupHostname,
      { cache: this.options.dnsValidationCache },
    );
    return materializeMcpRecord(record, credentialEnv);
  }

  async requireServer(
    appId: AppId,
    serverId: McpServerId,
  ): Promise<McpServerDefinition> {
    const server = await this.mcpServers.getServer(serverId);
    if (!server || server.appId !== appId) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server not found: ${serverId}`,
      );
    }
    return server;
  }

  private async assertAgentInApp(
    appId: AppId,
    agentId: AgentId,
  ): Promise<void> {
    if (!this.agents) return;
    const agent = await this.agents.getAgent(agentId);
    if (!agent || agent.appId !== appId) {
      throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
    }
  }

  private async audit(
    input: Omit<
      Parameters<McpServerRepository['appendAuditEvent']>[0],
      'id' | 'createdAt' | 'metadata'
    > & {
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.mcpServers.appendAuditEvent({
      id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
      ...input,
    });
  }
}

function buildVersion(input: {
  appId: AppId;
  serverId: McpServerId;
  version: number;
  transportConfig: McpServerTransportConfig;
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
  credentialRefs: McpCredentialRef[];
  sandboxProfileId?: string;
}): McpServerVersion {
  const configHash = hashMcpConfig({
    config: input.transportConfig,
    allowedToolPatterns: input.allowedToolPatterns,
    autoApproveToolPatterns: input.autoApproveToolPatterns,
    credentialRefs: input.credentialRefs,
    sandboxProfileId: input.sandboxProfileId,
  });
  return {
    id: `mcp-version:${globalThis.crypto.randomUUID()}` as McpServerVersionId,
    appId: input.appId,
    serverId: input.serverId,
    version: input.version,
    transport: input.transportConfig.transport,
    config: input.transportConfig,
    allowedToolPatterns: input.allowedToolPatterns,
    autoApproveToolPatterns: input.autoApproveToolPatterns,
    credentialRefs: input.credentialRefs,
    sandboxProfileId: input.sandboxProfileId,
    configHash,
    createdAt: nowIso(),
  };
}

export function hashMcpConfig(value: unknown): string {
  return `sha256:${stableSha256Json(value)}`;
}

const MCP_TOOL_PATTERN = /^[A-Za-z0-9_.-]+(?:\*)?$/;

function validateToolPatternPolicy(input: {
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
}): void {
  const allowed = new Set(input.allowedToolPatterns);
  for (const pattern of [
    ...input.allowedToolPatterns,
    ...input.autoApproveToolPatterns,
  ]) {
    if (!MCP_TOOL_PATTERN.test(pattern)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Invalid MCP tool pattern: ${pattern}`,
      );
    }
  }
  if (allowed.size === 0) return;
  for (const pattern of input.autoApproveToolPatterns) {
    if (
      ![...allowed].some((allowedPattern) =>
        toolPatternCovers(allowedPattern, pattern),
      )
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Auto-approved MCP tool must also be listed in allowedToolPatterns: ${pattern}`,
      );
    }
  }
}

function toolPatternCovers(allowedPattern: string, candidate: string): boolean {
  if (allowedPattern === candidate) return true;
  return allowedPattern.endsWith('*')
    ? candidate.startsWith(allowedPattern.slice(0, -1))
    : false;
}
