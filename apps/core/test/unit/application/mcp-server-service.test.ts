import { describe, expect, it, vi } from 'vitest';

import { McpServerService } from '@core/application/mcp/mcp-server-service.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpServerAuditEvent,
  McpServerDefinition,
  McpServerId,
} from '@core/domain/mcp/mcp-servers.js';
import type {
  AgentRepository,
  McpServerRepository,
} from '@core/domain/ports/repositories.js';

class MemoryMcpRepository implements McpServerRepository {
  readonly servers = new Map<string, McpServerDefinition>();
  readonly bindings = new Map<string, AgentMcpServerBinding>();
  readonly auditEvents: McpServerAuditEvent[] = [];

  async getServer(id: McpServerId): Promise<McpServerDefinition | null> {
    return this.servers.get(id) ?? null;
  }

  async getServerByName(input: {
    appId: string;
    name: string;
  }): Promise<McpServerDefinition | null> {
    return (
      [...this.servers.values()].find(
        (server) => server.appId === input.appId && server.name === input.name,
      ) ?? null
    );
  }

  async listServers(input: {
    appId: string;
    statuses?: McpServerDefinition['status'][];
  }): Promise<McpServerDefinition[]> {
    return [...this.servers.values()].filter(
      (server) =>
        server.appId === input.appId &&
        (!input.statuses || input.statuses.includes(server.status)),
    );
  }

  async saveServer(definition: McpServerDefinition): Promise<void> {
    this.servers.set(definition.id, definition);
  }

  async transitionServerStatus(input: {
    appId: string;
    serverId: McpServerId;
    expectedStatus: McpServerDefinition['status'];
    next: McpServerDefinition;
  }): Promise<McpServerDefinition | null> {
    const current = this.servers.get(input.serverId);
    if (
      !current ||
      current.appId !== input.appId ||
      current.status !== input.expectedStatus
    ) {
      return null;
    }
    this.servers.set(input.serverId, input.next);
    return input.next;
  }

  async saveAgentBinding(binding: AgentMcpServerBinding): Promise<void> {
    this.bindings.set(`${binding.agentId}:${binding.serverId}`, binding);
  }

  async saveAgentBindingsBatch(
    bindings: AgentMcpServerBinding[],
  ): Promise<void> {
    for (const binding of bindings) await this.saveAgentBinding(binding);
  }

  async getAgentBinding(input: {
    appId: string;
    agentId: string;
    serverId: McpServerId;
  }): Promise<AgentMcpServerBinding | null> {
    const binding = this.bindings.get(`${input.agentId}:${input.serverId}`);
    return binding?.appId === input.appId ? binding : null;
  }

  async disableAgentBinding(input: {
    appId: string;
    agentId: string;
    serverId: McpServerId;
    updatedAt: string;
  }): Promise<AgentMcpServerBinding | null> {
    const binding = this.bindings.get(`${input.agentId}:${input.serverId}`);
    if (!binding || binding.appId !== input.appId) return null;
    const disabled: AgentMcpServerBinding = {
      ...binding,
      status: 'disabled',
      updatedAt: input.updatedAt,
    };
    this.bindings.set(`${input.agentId}:${input.serverId}`, disabled);
    return disabled;
  }

  async listAgentBindings(input: {
    appId: string;
    agentId: string;
  }): Promise<AgentMcpServerBinding[]> {
    return [...this.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId && binding.agentId === input.agentId,
    );
  }

  async listAgentMcpAccessSnapshot(input: { appId: string; agentId: string }) {
    const activeBindings = (await this.listAgentBindings(input)).filter(
      (binding) => binding.status === 'active',
    );
    const rows = activeBindings.map((binding) => ({
      binding,
      definition: this.servers.get(binding.serverId) ?? null,
    }));
    return {
      activeBindings: rows,
      materializedServers: rows.flatMap((row) =>
        row.definition?.appId === input.appId &&
        row.definition.status === 'active'
          ? [{ binding: row.binding, definition: row.definition }]
          : [],
      ),
    };
  }

  async listAgentBindingsForAgents(input: {
    appId: string;
    agentIds: readonly string[];
  }): Promise<AgentMcpServerBinding[]> {
    const agentIds = new Set(input.agentIds);
    return [...this.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId && agentIds.has(binding.agentId),
    );
  }

  async listMaterializedServersForAgent(input: {
    appId: string;
    agentId: string;
    serverIds?: readonly McpServerId[];
  }): Promise<MaterializedMcpServer[]> {
    const serverIds = input.serverIds ? new Set(input.serverIds) : null;
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.appId === input.appId &&
          binding.agentId === input.agentId &&
          binding.status === 'active' &&
          (!serverIds || serverIds.has(binding.serverId)),
      )
      .map((binding) => ({
        binding,
        definition: this.servers.get(binding.serverId)!,
      }))
      .filter((record) => record.definition?.status === 'active');
  }

  async appendAuditEvent(event: McpServerAuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }

  async listAuditEvents(input: {
    appId: string;
    serverId?: McpServerId;
  }): Promise<McpServerAuditEvent[]> {
    return this.auditEvents.filter(
      (event) =>
        event.appId === input.appId &&
        (!input.serverId || event.serverId === input.serverId),
    );
  }
}

function serviceWithRepo() {
  const repo = new MemoryMcpRepository();
  const service = new McpServerService(repo, undefined, {
    lookupHostname: async () => [{ family: 4, address: '93.184.216.34' }],
  });
  return { repo, service };
}

describe('McpServerService', () => {
  it('labels validation without claiming a remote connection', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
    });

    await expect(
      service.testServer({ appId: 'app:one' as never, serverId: server.id }),
    ).resolves.toMatchObject({
      ok: true,
      message:
        'Configuration is valid. It did not contact the server or discover tools.',
    });
  });

  it('connects one current active MCP server definition', async () => {
    const { repo, service } = serviceWithRepo();

    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'GitHub',
      createdBy: 'admin',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      allowedToolPatterns: ['search_*'],
      autoApproveToolPatterns: ['search_repositories'],
      credentialRefs: [
        { name: 'GITHUB_TOKEN', target: 'header', key: 'Authorization' },
      ],
    });

    expect(server).toMatchObject({
      name: 'github',
      status: 'active',
      transport: 'http',
      config: { transport: 'http', url: 'https://mcp.example.test/github' },
      credentialRefs: [
        { name: 'GITHUB_TOKEN', target: 'header', key: 'Authorization' },
      ],
    });
    expect(repo.servers.get(server.id)).toBe(server);
    expect(repo.auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: 'connect',
        serverId: server.id,
        actorId: 'admin',
      }),
    );
  });

  it('persists declared network hosts and derives the remote URL host', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      networkHosts: ['api.github.com:443'],
    });
    expect(server.networkHosts).toContain('api.github.com:443');
    // The remote URL host is the only locally enforceable host, so it is added.
    expect(server.networkHosts).toContain('mcp.example.test:443');
  });

  it('derives the remote URL host when the same hostname is declared on another port', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      networkHosts: ['mcp.example.test:8443'],
    });
    expect(server.networkHosts).toContain('mcp.example.test:8443');
    expect(server.networkHosts).toContain('mcp.example.test:443');
  });

  it('rejects an invalid declared network host', async () => {
    const { service } = serviceWithRepo();
    await expect(
      service.connectServer({
        appId: 'app:one' as never,
        name: 'github',
        transportConfig: {
          transport: 'http',
          url: 'https://mcp.example.test/github',
        },
        networkHosts: ['https://api.github.com/v2'],
      }),
    ).rejects.toThrow(/networkHosts/i);
  });

  it('binds only active current definitions without version ids', async () => {
    const { repo, service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
    });

    const binding = await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverId: server.id,
      required: true,
    });

    expect(binding).toMatchObject({
      serverId: server.id,
      status: 'active',
      required: true,
    });
    expect(binding).not.toHaveProperty('versionId');

    repo.servers.set(server.id, { ...server, status: 'disabled' });
    await expect(
      service.bindToAgent({
        appId: 'app:one' as never,
        agentId: 'agent:two' as never,
        serverId: server.id,
      }),
    ).rejects.toThrow('active before binding');
  });

  it('bulk binds only distinct active agents without changing capability policy', async () => {
    const { repo } = serviceWithRepo();
    const agents = [
      {
        id: 'agent:one' as never,
        appId: 'app:one' as never,
        name: 'One',
        status: 'active' as const,
        createdAt: '2026-01-01T00:00:00.000Z' as never,
        updatedAt: '2026-01-01T00:00:00.000Z' as never,
      },
      {
        id: 'agent:two' as never,
        appId: 'app:one' as never,
        name: 'Two',
        status: 'active' as const,
        createdAt: '2026-01-01T00:00:00.000Z' as never,
        updatedAt: '2026-01-01T00:00:00.000Z' as never,
      },
    ];
    const service = new McpServerService(
      repo,
      { listAgents: async () => agents } as never,
      {
        lookupHostname: async () => [{ family: 4, address: '93.184.216.34' }],
      },
    );
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
    });

    const bindings = await service.bindToAgents({
      appId: 'app:one' as never,
      agentIds: agents.map((agent) => agent.id),
      serverId: server.id,
    });

    expect(bindings).toHaveLength(2);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: false,
          permissionPolicyIds: [],
          allowedToolPatterns: [],
        }),
      ]),
    );
    await expect(
      service.bindToAgents({
        appId: 'app:one' as never,
        agentIds: ['agent:one' as never, 'agent:one' as never],
        serverId: server.id,
      }),
    ).rejects.toThrow('distinct agents');
  });

  it('scopes a binding to a subset of the reviewed tools per agent', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      allowedToolPatterns: ['read_*', 'write_*'],
    });

    const readOnly = await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:reader' as never,
      serverId: server.id,
      allowedToolPatterns: ['read_*'],
    });
    expect(readOnly.allowedToolPatterns).toEqual(['read_*']);

    const readWrite = await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:writer' as never,
      serverId: server.id,
      allowedToolPatterns: ['read_*', 'write_*'],
    });
    expect(readWrite.allowedToolPatterns).toEqual(['read_*', 'write_*']);
  });

  it('scopes bindings against auto-approved tools when no allowed patterns exist', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      autoApproveToolPatterns: ['search'],
    });

    const binding = await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:reader' as never,
      serverId: server.id,
      allowedToolPatterns: ['search'],
    });
    expect(binding.allowedToolPatterns).toEqual(['search']);
  });

  it('rejects a binding tool scope outside the reviewed tools', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      allowedToolPatterns: ['read_*'],
    });
    await expect(
      service.bindToAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        serverId: server.id,
        allowedToolPatterns: ['delete_repo'],
      }),
    ).rejects.toThrow(/not within the reviewed tools/);
  });

  it('preserves the complete existing authority row when rebinding', async () => {
    const { repo, service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
    });

    await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverId: server.id,
      required: true,
      permissionPolicyIds: ['permission-policy:one' as never],
    });
    const bindingKey = `agent:one:${server.id}`;
    repo.bindings.set(bindingKey, {
      ...repo.bindings.get(bindingKey)!,
      conversationId: 'conversation:review' as never,
      threadId: 'thread:review:topic' as never,
    });
    const rebound = await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverId: server.id,
      permissionPolicyIds: ['permission-policy:two' as never],
    });

    expect(rebound.required).toBe(true);
    expect(rebound.permissionPolicyIds).toEqual(['permission-policy:two']);
    expect(rebound.conversationId).toBe('conversation:review');
    expect(rebound.threadId).toBe('thread:review:topic');
  });

  it('skips selected MCP projection when its credential ref is missing', async () => {
    const { repo, service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'stdio_template',
        templateId: 'npx-package',
        args: ['@modelcontextprotocol/server-github'],
      },
      sandboxProfileId: 'sandbox:mcp',
      credentialRefs: [
        { name: 'GITHUB_TOKEN', target: 'env', key: 'GITHUB_TOKEN' },
      ],
    });
    await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverId: server.id,
      required: true,
    });

    const capabilities = await service.materializeForAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverIds: [server.id],
      credentialEnv: {},
    });

    expect(capabilities).toEqual([]);
    expect(repo.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'startup_failure',
          serverId: server.id,
          agentId: 'agent:one',
          reason: expect.stringContaining('Credential Center'),
        }),
      ]),
    );
    expect(JSON.stringify(repo.auditEvents)).not.toContain('GITHUB_TOKEN');
  });

  it('fails required remote MCP materialization when DNS validation times out', async () => {
    const repo = new MemoryMcpRepository();
    const service = new McpServerService(repo, undefined, {
      lookupHostname: vi.fn(
        () => new Promise<Array<{ address: string; family: 4 | 6 }>>(() => {}),
      ),
      dnsLookupTimeoutMs: 1,
    });
    const serverId = 'mcp:github' as McpServerId;
    repo.servers.set(serverId, {
      id: serverId,
      appId: 'app:one' as never,
      name: 'github',
      status: 'active',
      transport: 'http',
      config: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      allowedToolPatterns: ['search_*'],
      autoApproveToolPatterns: [],
      credentialRefs: [],
      networkHosts: ['mcp.example.test:443'],
      createdSource: 'admin',
      riskClass: 'medium',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    repo.bindings.set(`agent:one:${serverId}`, {
      id: 'mcp-binding:one' as never,
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverId,
      status: 'active',
      required: true,
      allowedToolPatterns: [],
      permissionPolicyIds: [],
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    await expect(
      service.materializeForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
      }),
    ).rejects.toThrow(/Required MCP server failed to materialize: github/);
  });

  it('fails closed when snapshot MCP config belongs to another agent', async () => {
    const { service } = serviceWithRepo();
    const serverId = 'mcp:github' as McpServerId;

    await expect(
      service.materializeForAgent({
        appId: 'app:one' as never,
        agentId: 'agent:one' as never,
        accessSnapshot: {
          appId: 'app:one',
          agentId: 'agent:one',
          tools: { activeBindings: [], appActiveDefinitions: [] },
          skills: { activeBindings: [], enabledDefinitions: [] },
          mcp: {
            activeBindings: [],
            materializedServers: [
              {
                definition: {
                  id: serverId,
                  appId: 'app:one',
                  name: 'github',
                  status: 'active',
                  transport: 'http',
                  config: {
                    transport: 'http',
                    url: 'https://mcp.example.test/github',
                  },
                  allowedToolPatterns: ['search_*'],
                  autoApproveToolPatterns: [],
                  credentialRefs: [],
                  networkHosts: ['mcp.example.test:443'],
                  createdSource: 'admin',
                  riskClass: 'medium',
                  createdAt: '2026-06-02T00:00:00.000Z',
                  updatedAt: '2026-06-02T00:00:00.000Z',
                },
                binding: {
                  id: 'mcp-binding:one' as never,
                  appId: 'app:one',
                  agentId: 'agent:other',
                  serverId,
                  status: 'active',
                  required: false,
                  allowedToolPatterns: [],
                  permissionPolicyIds: [],
                  createdAt: '2026-06-02T00:00:00.000Z',
                  updatedAt: '2026-06-02T00:00:00.000Z',
                },
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(
      'MCP materialization MCP materialized snapshot row owner mismatch.',
    );
  });

  it('revalidates a disabled source and leaves prior bindings disabled', async () => {
    const { repo, service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      allowedToolPatterns: ['search_*', 'read_*'],
      credentialRefs: [
        { name: 'GITHUB_TOKEN', target: 'env', key: 'GITHUB_TOKEN' },
        { name: 'TENANT', target: 'header', key: 'x-tenant' },
      ],
    });
    await service.bindToAgent({
      appId: 'app:one' as never,
      agentId: 'agent:one' as never,
      serverId: server.id,
    });

    await service.disableServer({
      appId: 'app:one' as never,
      serverId: server.id,
    });

    expect(repo.servers.get(server.id)).toMatchObject({ status: 'disabled' });
    expect(repo.bindings.get(`agent:one:${server.id}`)).toMatchObject({
      status: 'active',
    });
    const reconnectService = new McpServerService(
      repo,
      {
        listAgents: async () => [
          { id: 'agent:one' as never, appId: 'app:one' as never },
        ],
      } as AgentRepository,
      { lookupHostname: async () => [{ family: 4, address: '93.184.216.34' }] },
    );
    const reconnected = await reconnectService.reconnectServer({
      appId: 'app:one' as never,
      serverId: server.id,
      reconnectedBy: 'test-admin',
    });
    expect(reconnected.id).toBe(server.id);
    expect(reconnected.status).toBe('active');
    expect(repo.bindings.get(`agent:one:${server.id}`)).toMatchObject({
      status: 'disabled',
    });
    expect(repo.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'reconnect',
          actorId: 'test-admin',
        }),
        expect.objectContaining({ eventType: 'unbind' }),
      ]),
    );
  });

  it('requires a new name when replacing a disabled server definition', async () => {
    const { service } = serviceWithRepo();
    const server = await service.connectServer({
      appId: 'app:one' as never,
      name: 'github',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
      allowedToolPatterns: ['search_*'],
    });
    await service.disableServer({
      appId: 'app:one' as never,
      serverId: server.id,
    });

    await expect(
      service.connectServer({
        appId: 'app:one' as never,
        name: 'github',
        transportConfig: {
          transport: 'http',
          url: 'https://replacement.example.test/github',
        },
        allowedToolPatterns: ['search_*'],
      }),
    ).rejects.toThrow('Revalidate and reconnect it instead');
  });

  it('rejects duplicate current definitions by normalized name', async () => {
    const { service } = serviceWithRepo();
    await service.connectServer({
      appId: 'app:one' as never,
      name: 'GitHub',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.example.test/github',
      },
    });

    await expect(
      service.connectServer({
        appId: 'app:one' as never,
        name: 'github',
        transportConfig: {
          transport: 'http',
          url: 'https://mcp.example.test/github',
        },
      }),
    ).rejects.toThrow('MCP server already exists: github');
  });
});
