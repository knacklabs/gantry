import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpServerDefinition } from '@core/domain/mcp/mcp-servers.js';
import type {
  AgentToolBinding,
  ToolCatalogItem,
} from '@core/domain/tools/tools.js';
import { McpToolProxy } from '@core/application/mcp/mcp-tool-proxy.js';
import { McpCapabilitySyncService } from '@core/application/mcp/mcp-capability-sync-service.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

const appId = 'default' as never;
const agentId = 'agent:main' as never;

function server(): McpServerDefinition {
  return {
    id: 'mcp:itops' as never,
    appId,
    name: 'itops',
    status: 'active',
    createdSource: 'admin',
    riskClass: 'medium',
    transport: 'http',
    config: { transport: 'http', url: 'http://127.0.0.1:4100/mcp' },
    allowedToolPatterns: ['itops_*'],
    autoApproveToolPatterns: [],
    credentialRefs: [],
    networkHosts: [],
    createdAt: '2026-01-01T00:00:00.000Z' as never,
    updatedAt: '2026-01-01T00:00:00.000Z' as never,
  };
}

function capabilityTool(input?: { includeSource?: boolean }): ToolCatalogItem {
  const capability = {
    capabilityId: 'itops.access.manage',
    version: '1',
    displayName: 'IT Ops access manage',
    category: 'IT Ops',
    risk: 'write' as const,
    can: 'Manage reviewed IT Ops access.',
    cannot: 'Use unrelated systems.',
    credentialSource: 'configured_access' as const,
    implementationBindings: [
      {
        kind: 'mcp_tool' as const,
        mcpTool: 'mcp__itops__itops_get_employee_access',
      },
    ],
    ...(input?.includeSource === false
      ? {}
      : {
          source: {
            source: 'mcp',
            serverName: 'itops',
            allowedToolPatterns: ['itops_*'],
          },
        }),
  };
  return {
    id: 'tool:capability:itops.access.manage' as never,
    appId,
    name: 'capability:itops.access.manage',
    kind: 'host',
    provider: 'gantry',
    displayName: 'IT Ops access manage',
    description:
      'Manage reviewed IT Ops access. Cannot: Use unrelated systems.',
    category: 'productivity',
    risk: 'high',
    selectable: true,
    status: 'active',
    inputSchema: semanticCapabilityInputSchema(capability),
    adapterRef: 'capability/itops.access.manage',
    createdAt: '2026-01-01T00:00:00.000Z' as never,
    updatedAt: '2026-01-01T00:00:00.000Z' as never,
  };
}

function activeBinding(tool: ToolCatalogItem): AgentToolBinding {
  return {
    id: 'agent-tool-binding:one' as never,
    appId,
    agentId,
    toolId: tool.id,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z' as never,
    updatedAt: '2026-01-01T00:00:00.000Z' as never,
  };
}

function serviceWithRepos(input?: {
  saveTool?: (tool: ToolCatalogItem) => void;
  tool?: ToolCatalogItem;
}) {
  const mcpServer = server();
  const tool = input?.tool ?? capabilityTool();
  const repositories = {
    mcpServers: {
      getServer: vi.fn(async () => mcpServer),
      listMaterializedServersForAgent: vi.fn(async () => []),
      appendAuditEvent: vi.fn(async () => undefined),
    },
    tools: {
      listTools: vi.fn(async () => [tool]),
      listAgentToolBindings: vi.fn(async () => [activeBinding(tool)]),
      getTool: vi.fn(async () => tool),
      saveTool: vi.fn(async (saved: ToolCatalogItem) => {
        input?.saveTool?.(saved);
      }),
    },
    skills: {
      listAgentSkillBindings: vi.fn(async () => []),
      getSkill: vi.fn(async () => null),
    },
    capabilitySecrets: {},
  };
  return {
    mcpServer,
    tool,
    repositories,
    service: new McpCapabilitySyncService(repositories as never, {
      lookupHostname: vi.fn(async () => []),
    }),
  };
}

describe('McpCapabilitySyncService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds visible source tools to the reviewed semantic capability', async () => {
    vi.spyOn(McpToolProxy.prototype, 'listTools').mockResolvedValue({
      servers: [
        {
          name: 'itops',
          tools: [
            { name: 'itops_get_employee_access', description: '' },
            { name: 'itops_get_connector_health', description: '' },
          ],
        },
      ],
      limit: 50,
      total: 2,
      diagnostics: { remoteListTruncated: false },
    } as never);
    let savedTool: ToolCatalogItem | undefined;
    const { repositories, service } = serviceWithRepos({
      saveTool: (tool) => {
        savedTool = tool;
      },
    });

    const result = await service.sync({
      appId,
      agentId,
      serverId: 'mcp:itops' as never,
      capabilityId: 'itops.access.manage',
      dryRun: false,
      syncedBy: 'ops-admin',
      egressDenylist: [],
    });

    expect(result.addedTools).toEqual([
      'mcp__itops__itops_get_connector_health',
    ]);
    expect(result.changed).toBe(true);
    expect(repositories.tools.saveTool).toHaveBeenCalledTimes(1);
    expect(repositories.mcpServers.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'capability_sync',
        actorId: 'ops-admin',
        metadata: {
          capabilityId: 'itops.access.manage',
          addedTools: ['mcp__itops__itops_get_connector_health'],
          addedToolCount: 1,
          existingBindingCount: 1,
          nextBindingCount: 2,
        },
      }),
    );
    expect(JSON.stringify(savedTool?.inputSchema)).toContain(
      'mcp__itops__itops_get_connector_health',
    );
  });

  it('reports missing bindings without mutating the catalog during dry-run', async () => {
    vi.spyOn(McpToolProxy.prototype, 'listTools').mockResolvedValue({
      servers: [
        {
          name: 'itops',
          tools: [{ name: 'itops_get_connector_health', description: '' }],
        },
      ],
      limit: 50,
      total: 1,
      diagnostics: { remoteListTruncated: false },
    } as never);
    const { repositories, service } = serviceWithRepos();

    const result = await service.sync({
      appId,
      agentId,
      serverId: 'mcp:itops' as never,
      capabilityId: 'itops.access.manage',
      dryRun: true,
      egressDenylist: [],
    });

    expect(result.addedTools).toEqual([
      'mcp__itops__itops_get_connector_health',
    ]);
    expect(result.changed).toBe(false);
    expect(result.warning).toContain('Dry run only');
    expect(repositories.tools.saveTool).not.toHaveBeenCalled();
    expect(repositories.mcpServers.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses to sync legacy MCP capabilities without reviewed source scope metadata', async () => {
    vi.spyOn(McpToolProxy.prototype, 'listTools').mockResolvedValue({
      servers: [
        {
          name: 'itops',
          tools: [{ name: 'itops_get_connector_health', description: '' }],
        },
      ],
      limit: 50,
      total: 1,
      diagnostics: { remoteListTruncated: false },
    } as never);
    const { repositories, service } = serviceWithRepos({
      tool: capabilityTool({ includeSource: false }),
    });

    await expect(
      service.sync({
        appId,
        agentId,
        serverId: 'mcp:itops' as never,
        capabilityId: 'itops.access.manage',
        dryRun: false,
        egressDenylist: [],
      }),
    ).rejects.toThrow(
      'Capability itops.access.manage is not bound to MCP server itops.',
    );
    expect(repositories.tools.saveTool).not.toHaveBeenCalled();
    expect(repositories.mcpServers.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses to mutate reviewed capability bindings from truncated MCP inventory', async () => {
    vi.spyOn(McpToolProxy.prototype, 'listTools').mockResolvedValue({
      servers: [
        {
          name: 'itops',
          tools: [{ name: 'itops_get_connector_health', description: '' }],
        },
      ],
      limit: 50,
      total: 51,
      diagnostics: { remoteListTruncated: true },
    } as never);
    const { repositories, service } = serviceWithRepos();

    await expect(
      service.sync({
        appId,
        agentId,
        serverId: 'mcp:itops' as never,
        capabilityId: 'itops.access.manage',
        dryRun: false,
        egressDenylist: [],
      }),
    ).rejects.toThrow('MCP source inventory for itops was truncated.');
    expect(repositories.tools.saveTool).not.toHaveBeenCalled();
    expect(repositories.mcpServers.appendAuditEvent).not.toHaveBeenCalled();
  });
});
