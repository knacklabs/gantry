import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerDefinition,
  McpServerId,
} from '../../domain/mcp/mcp-servers.js';
import { isMcpServerActive } from '../../domain/mcp/mcp-servers.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { isThirdPartyMcpToolRule } from '../../shared/agent-tool-references.js';
import { reviewedExternalMcpToolNamesFromRuntimeAccess } from '../../shared/capability-runtime-access.js';
import { semanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { mcpToolNameAllowedBySourceScope } from '../../shared/mcp-tool-scope.js';
import {
  semanticCapabilityFromToolCatalogItem,
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { ApplicationError } from '../common/application-error.js';
import { resolveAgentToolRuntimePolicy } from '../agents/agent-tool-runtime-rules.js';
import { resolveMcpCredentialEnvForAgent } from '../capability-secrets/mcp-secret-projection.js';
import { McpToolProxy } from './mcp-tool-proxy.js';

export interface McpCapabilityDriftDiagnostics {
  agentId: string;
  serverName: string;
  visibleTools: string[];
  approvedTools: string[];
  blockedByCapabilityReview: string[];
  inventoryTruncated?: boolean;
  warning?: string;
}

export interface McpCapabilitySyncResult {
  ok: true;
  dryRun: boolean;
  capabilityId: string;
  serverName: string;
  visibleTools: string[];
  approvedToolsBefore: string[];
  addedTools: string[];
  changed: boolean;
  warning?: string;
}

export class McpCapabilitySyncService {
  constructor(
    private readonly repositories: {
      mcpServers: McpServerRepository;
      tools: ToolCatalogRepository;
      skills: SkillCatalogRepository;
      capabilitySecrets: CapabilitySecretRepository;
    },
    private readonly options: {
      lookupHostname: HostnameLookup;
    },
  ) {}

  async diagnose(input: {
    appId: AppId;
    agentId: AgentId;
    server: McpServerDefinition;
    egressDenylist: readonly string[];
  }): Promise<McpCapabilityDriftDiagnostics> {
    const credentialEnv = await resolveMcpCredentialEnvForAgent({
      appId: input.appId,
      agentId: input.agentId,
      mcpServers: this.repositories.mcpServers,
      secrets: this.repositories.capabilitySecrets,
      serverIds: [input.server.id],
    });
    const proxy = new McpToolProxy(this.repositories.mcpServers, {
      tools: this.repositories.tools,
      skills: this.repositories.skills,
      credentialEnv,
      sourceServerIds: [input.server.id],
      lookupHostname: this.options.lookupHostname,
      egressDenylist: input.egressDenylist,
    });
    const [inventory, policy] = await Promise.all([
      proxy.listTools({
        appId: input.appId,
        agentId: input.agentId,
        serverName: input.server.name,
        limit: 50,
      }),
      resolveAgentToolRuntimePolicy({
        repository: this.repositories.tools,
        skillRepository: this.repositories.skills,
        appId: input.appId,
        agentId: input.agentId,
        errorSubject: 'Configured agent tool',
      }),
    ]);
    const visibleTools = inventory.servers.flatMap((server) =>
      server.tools.map((tool) => `mcp__${server.name}__${tool.name}`),
    );
    const approvedTools = reviewedExternalMcpToolNamesFromRuntimeAccess(
      policy.runtimeAccess,
      { serverNames: [input.server.name] },
    ).sort();
    const approved = new Set(approvedTools);
    const blockedByCapabilityReview = visibleTools
      .filter((tool) => !approved.has(tool))
      .sort();
    return {
      agentId: input.agentId,
      serverName: input.server.name,
      visibleTools: [...visibleTools].sort(),
      approvedTools,
      blockedByCapabilityReview,
      ...(inventory.diagnostics.remoteListTruncated
        ? { inventoryTruncated: true }
        : {}),
      ...(blockedByCapabilityReview.length > 0
        ? {
            warning:
              'MCP source is healthy, but some visible tools are not approved by selected agent capabilities. Review semantic capability implementationBindings before users call them.',
          }
        : {}),
    };
  }

  async sync(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    capabilityId: string;
    dryRun: boolean;
    syncedBy?: string;
    egressDenylist: readonly string[];
  }): Promise<McpCapabilitySyncResult> {
    const server = await this.requireActiveServer(input.appId, input.serverId);
    const diagnostics = await this.diagnose({
      appId: input.appId,
      agentId: input.agentId,
      server,
      egressDenylist: input.egressDenylist,
    });
    const tool = await this.semanticCapabilityToolForId({
      appId: input.appId,
      capabilityId: input.capabilityId,
    });
    if (!tool) {
      throw new ApplicationError(
        'NOT_FOUND',
        `Reviewed capability ${input.capabilityId} is not registered.`,
      );
    }
    const capability = semanticCapabilityFromToolCatalogItem({
      name: tool.name,
      inputSchema: tool.inputSchema,
    });
    if (!capability) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Tool catalog row ${tool.id} is not a semantic capability.`,
      );
    }
    const sourceScope = mcpCapabilitySourceScopeForServer(
      capability,
      server.name,
    );
    if (!sourceScope) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Capability ${input.capabilityId} is not bound to MCP server ${server.name}.`,
      );
    }
    if (!input.dryRun && diagnostics.inventoryTruncated) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        [
          `MCP source inventory for ${server.name} was truncated.`,
          'Refusing to sync a partial tool list; inspect the source inventory and retry once the full tool list is available.',
        ].join(' '),
      );
    }
    const existingBindings = new Set(
      capability.implementationBindings
        .map((binding) => binding.mcpTool?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    const addedTools = diagnostics.visibleTools
      .filter((toolName) => isThirdPartyMcpToolRule(toolName))
      .filter((toolName) => !existingBindings.has(toolName))
      .filter((toolName) =>
        mcpToolNameAllowedBySourceScope({
          serverName: server.name,
          fullToolName: toolName,
          allowedToolPatterns: sourceScope.allowedToolPatterns,
        }),
      )
      .sort();
    if (!input.dryRun && addedTools.length > 0) {
      await this.saveSyncedCapability({
        tool,
        capability,
        appId: input.appId,
        agentId: input.agentId,
        server,
        capabilityId: input.capabilityId,
        addedTools,
        syncedBy: input.syncedBy,
      });
    }
    return {
      ok: true,
      dryRun: input.dryRun,
      capabilityId: input.capabilityId,
      serverName: server.name,
      visibleTools: diagnostics.visibleTools,
      approvedToolsBefore: diagnostics.approvedTools,
      addedTools,
      changed: !input.dryRun && addedTools.length > 0,
      ...(input.dryRun && addedTools.length > 0
        ? {
            warning:
              'Dry run only. Re-run without dryRun to update the reviewed capability bindings.',
          }
        : {}),
    };
  }

  private async requireActiveServer(
    appId: AppId,
    serverId: McpServerId,
  ): Promise<McpServerDefinition> {
    const server = await this.repositories.mcpServers.getServer(serverId);
    if (!server || server.appId !== appId || !isMcpServerActive(server)) {
      throw new ApplicationError(
        'NOT_FOUND',
        `Active MCP server ${serverId} was not found.`,
      );
    }
    return server;
  }

  private async semanticCapabilityToolForId(input: {
    appId: AppId;
    capabilityId: string;
  }): Promise<ToolCatalogItem | undefined> {
    const expectedName = semanticCapabilityRule(input.capabilityId);
    const tools = await this.repositories.tools.listTools({
      appId: input.appId,
      statuses: ['active'],
    });
    return tools.find((tool) => {
      if (!tool.selectable || tool.name !== expectedName) return false;
      const capability = semanticCapabilityFromToolCatalogItem({
        name: tool.name,
        inputSchema: tool.inputSchema,
      });
      return capability?.capabilityId === input.capabilityId;
    });
  }

  private async saveSyncedCapability(input: {
    tool: ToolCatalogItem;
    capability: SemanticCapabilityDefinition;
    appId: AppId;
    agentId: AgentId;
    server: McpServerDefinition;
    capabilityId: string;
    addedTools: string[];
    syncedBy?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const nextCapability: SemanticCapabilityDefinition = {
      ...input.capability,
      implementationBindings: [
        ...input.capability.implementationBindings,
        ...input.addedTools.map((mcpTool) => ({
          kind: 'mcp_tool' as const,
          mcpTool,
        })),
      ],
    };
    await this.repositories.tools.saveTool({
      ...input.tool,
      inputSchema: semanticCapabilityInputSchema(nextCapability),
      description: `${nextCapability.can} Cannot: ${nextCapability.cannot}`,
      updatedAt: now as ToolCatalogItem['updatedAt'],
    });
    await this.repositories.mcpServers.appendAuditEvent({
      id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.server.id,
      eventType: 'capability_sync',
      actorId: input.syncedBy,
      reason:
        'Reviewed semantic capability bindings synced from MCP source inventory.',
      metadata: {
        capabilityId: input.capabilityId,
        addedTools: input.addedTools,
        addedToolCount: input.addedTools.length,
        existingBindingCount: input.capability.implementationBindings.length,
        nextBindingCount: nextCapability.implementationBindings.length,
      },
      createdAt: now as never,
    });
  }
}

function mcpCapabilitySourceScopeForServer(
  capability: SemanticCapabilityDefinition,
  serverName: string,
): { allowedToolPatterns: string[] } | null {
  const sourceScope = parseMcpCapabilitySourceScope(capability.source);
  return sourceScope?.serverName === serverName
    ? { allowedToolPatterns: sourceScope.allowedToolPatterns }
    : null;
}

function parseMcpCapabilitySourceScope(
  source: unknown,
): { serverName: string; allowedToolPatterns: string[] } | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  if (record.source !== 'mcp' || typeof record.serverName !== 'string') {
    return null;
  }
  return {
    serverName: record.serverName.trim(),
    allowedToolPatterns: Array.isArray(record.allowedToolPatterns)
      ? record.allowedToolPatterns
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  };
}
