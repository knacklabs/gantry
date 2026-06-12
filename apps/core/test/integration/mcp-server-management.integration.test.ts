import { describe, expect, it, beforeEach, vi } from 'vitest';

import { McpServerService } from '@core/application/mcp/mcp-server-service.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpServerAuditEvent,
  McpServerDefinition,
  McpServerId,
} from '@core/domain/mcp/mcp-servers.js';
import type { McpServerRepository } from '@core/domain/ports/repositories.js';
import { syncRuntimeSettingsFromProjection } from '@core/config/index.js';
import { createClient } from '../../../../packages/sdk/src/index.js';
import { startTestControlServer } from '../harness/control-http-server.js';

class InMemoryMcpServerRepository implements McpServerRepository {
  servers = new Map<string, McpServerDefinition>();
  bindings = new Map<string, AgentMcpServerBinding>();
  auditEvents: McpServerAuditEvent[] = [];

  async getServer(id: McpServerId) {
    return this.servers.get(id) ?? null;
  }

  async getServerByName(input: { appId: AppId; name: string }) {
    return (
      [...this.servers.values()].find(
        (server) => server.appId === input.appId && server.name === input.name,
      ) ?? null
    );
  }

  async listServers(input: {
    appId: AppId;
    statuses?: McpServerDefinition['status'][];
    limit?: number;
    cursor?: string;
  }) {
    return [...this.servers.values()]
      .filter(
        (server) =>
          server.appId === input.appId &&
          (!input.statuses || input.statuses.includes(server.status)) &&
          (!input.cursor || server.updatedAt < input.cursor),
      )
      .slice(0, input.limit ?? 100);
  }

  async saveServer(definition: McpServerDefinition) {
    this.servers.set(definition.id, definition);
  }

  async transitionServerStatus(input: {
    appId: AppId;
    serverId: McpServerId;
    expectedStatus: McpServerDefinition['status'];
    next: McpServerDefinition;
  }) {
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

  async saveAgentBinding(binding: AgentMcpServerBinding) {
    this.bindings.set(
      `${binding.appId}:${binding.agentId}:${binding.serverId}`,
      binding,
    );
  }

  async disableAgentBinding(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    updatedAt: string;
  }) {
    const key = `${input.appId}:${input.agentId}:${input.serverId}`;
    const current = this.bindings.get(key);
    if (!current) return null;
    const disabled = {
      ...current,
      status: 'disabled' as const,
      updatedAt: input.updatedAt,
    };
    this.bindings.set(key, disabled);
    return disabled;
  }

  async listAgentBindings(input: {
    appId: AppId;
    agentId: AgentId;
    limit?: number;
    cursor?: string;
  }) {
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.appId === input.appId &&
          binding.agentId === input.agentId &&
          (!input.cursor || binding.updatedAt < input.cursor),
      )
      .slice(0, input.limit ?? 100);
  }

  async listAgentBindingsForAgents(input: {
    appId: AppId;
    agentIds: readonly AgentId[];
    limitPerAgent?: number;
  }) {
    const agentIds = new Set(input.agentIds);
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.appId === input.appId && agentIds.has(binding.agentId),
      )
      .slice(
        0,
        (input.limitPerAgent ?? 100) * Math.max(input.agentIds.length, 1),
      );
  }

  async listMaterializedServersForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverIds?: readonly McpServerId[];
  }): Promise<MaterializedMcpServer[]> {
    if (input.serverIds && input.serverIds.length === 0) return [];
    const selectedServerIds = input.serverIds
      ? new Set(input.serverIds)
      : undefined;
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.appId === input.appId &&
          binding.agentId === input.agentId &&
          binding.status === 'active' &&
          (!selectedServerIds || selectedServerIds.has(binding.serverId)),
      )
      .map((binding) => ({
        binding,
        definition: this.servers.get(binding.serverId)!,
      }))
      .filter((record) => record.definition?.status === 'active');
  }

  async appendAuditEvent(event: McpServerAuditEvent) {
    this.auditEvents.push(event);
  }

  async listAuditEvents(input: {
    appId: AppId;
    serverId?: McpServerId;
    limit?: number;
    cursor?: string;
  }) {
    return this.auditEvents
      .filter(
        (event) =>
          event.appId === input.appId &&
          (!input.serverId || event.serverId === input.serverId) &&
          (!input.cursor || event.createdAt < input.cursor),
      )
      .slice(0, input.limit ?? 100);
  }
}

const state = vi.hoisted(() => ({
  mcpServers: undefined as unknown as InMemoryMcpServerRepository,
}));

vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-mcp-integration-home',
  DATA_DIR: '/tmp/gantry-mcp-integration-home/data',
  GANTRY_IPC_AUTH_SECRET: 'test-ipc-secret',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  getRuntimeSettingsForConfig: vi.fn(() => ({
    agents: {
      'agent:one': { accessPreset: 'full' },
    },
  })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
  configureDesiredSettingsStorageProvider: vi.fn(() => undefined),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isJobTriggerQueueReady: vi.fn(() => true),
  isSchedulerReady: vi.fn(() => true),
  runtimeJobSchedulePlanner: {
    createManualJobId: () => 'job-test',
    createJobId: () => 'job-test',
    planAppSchedule: () => ({
      scheduleType: 'manual',
      scheduleValue: 'manual',
      nextRun: null,
    }),
  },
  requestSchedulerSync: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => {
  const agents = {
    getAgent: vi.fn(async (id: string) =>
      id === 'agent:one'
        ? {
            id,
            appId: 'app-one',
            name: 'Agent One',
            status: 'active',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          }
        : null,
    ),
    listAgents: vi.fn(async () => []),
  };
  return {
    getRuntimeControlRepository: () => ({
      listDueWebhookDeliveries: vi.fn(async () => []),
      claimDueWebhookDeliveries: vi.fn(async () => []),
    }),
    getRuntimeRepositories: () => ({
      getAllConversationRoutes: vi.fn(async () => ({})),
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    }),
    getRuntimeStorage: () => ({
      repositories: {
        agents,
        mcpServers: state.mcpServers,
        tools: {
          listTools: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(async () => []),
        },
        skills: {
          listSkills: vi.fn(async () => []),
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
        },
        providerConnections: {
          listProviderConnections: vi.fn(async () => []),
          listAgentConversationBindings: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => []),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    }),
  };
});

beforeEach(() => {
  state.mcpServers = new InMemoryMcpServerRepository();
  vi.clearAllMocks();
});

const githubConnectInput = {
  name: 'github',
  transport: 'stdio_template' as const,
  config: {
    transport: 'stdio_template',
    templateId: 'npx-package',
    args: ['@modelcontextprotocol/server-github'],
  },
  sandboxProfileId: 'sandbox:mcp-github',
  allowedToolPatterns: ['search_repositories'],
  autoApproveToolPatterns: ['search_repositories'],
  credentialRefs: [
    { name: 'GITHUB_TOKEN', target: 'env' as const, key: 'GITHUB_TOKEN' },
  ],
};

describe('MCP server management integration', () => {
  it('connects, lists, shows, tests, binds, materializes, and disables current MCP definitions', async () => {
    const server = await startTestControlServer({
      token: 'token-mcp',
      appId: 'app-one',
      scopes: ['mcp:read', 'mcp:admin', 'agents:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const connected = await client.mcpServers.connect(githubConnectInput);
      const definition = (connected as any).server as McpServerDefinition;
      expect(definition).toMatchObject({
        appId: 'app-one',
        name: 'github',
        status: 'active',
        transport: 'stdio_template',
        allowedToolPatterns: ['search_repositories'],
      });
      expect(definition).not.toHaveProperty('versionId');

      await expect(
        client.mcpServers.list({ status: 'active' }),
      ).resolves.toEqual(
        expect.objectContaining({
          servers: [expect.objectContaining({ id: definition.id })],
        }),
      );
      await expect(client.mcpServers.get(definition.id)).resolves.toEqual(
        expect.objectContaining({
          server: expect.objectContaining({ id: definition.id }),
        }),
      );
      await expect(client.mcpServers.test(definition.id)).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          server: expect.objectContaining({ id: definition.id }),
        }),
      );

      const binding = await client.agents.mcpServers.enable(
        'agent:one',
        definition.id,
        { required: true },
      );
      expect((binding as any).binding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        serverId: definition.id,
        status: 'active',
        required: true,
      });
      expect((binding as any).binding).not.toHaveProperty('versionId');

      const service = new McpServerService(state.mcpServers, undefined, {
        auditMaterialization: true,
      });
      await expect(
        service.materializeForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
          credentialEnv: { GITHUB_TOKEN: 'broker-safe-token' },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          name: 'github',
          allowedToolNames: ['mcp__github__search_repositories'],
          autoApproveToolNames: ['mcp__github__search_repositories'],
        }),
      ]);

      await expect(
        client.agents.mcpServers.disable('agent:one', definition.id),
      ).resolves.toEqual(
        expect.objectContaining({
          disabled: true,
          binding: expect.objectContaining({ status: 'disabled' }),
        }),
      );
      await expect(client.mcpServers.disable(definition.id)).resolves.toEqual(
        expect.objectContaining({
          server: expect.objectContaining({ status: 'disabled' }),
        }),
      );
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalled();
      expect(
        state.mcpServers.auditEvents.map((event) => event.eventType),
      ).toEqual(
        expect.arrayContaining([
          'connect',
          'test',
          'bind',
          'materialize',
          'unbind',
          'disable',
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects unsafe or duplicate MCP connects without creating another resource', async () => {
    const service = new McpServerService(state.mcpServers);
    await service.connectServer({
      appId: 'app-one' as never,
      ...githubConnectInput,
      transportConfig: githubConnectInput.config,
    });

    await expect(
      service.connectServer({
        appId: 'app-one' as never,
        ...githubConnectInput,
        transportConfig: githubConnectInput.config,
      }),
    ).rejects.toThrow('MCP server already exists');

    await expect(
      service.connectServer({
        appId: 'app-one' as never,
        name: 'raw_secret',
        sandboxProfileId: 'sandbox:mcp-github',
        transportConfig: {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_raw_secret_value' },
        },
      }),
    ).rejects.toThrow('credentialRefs');
    expect(state.mcpServers.servers.size).toBe(1);
  });

  it('agent-requested MCP approval connects and binds the current server directly', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_mcp_server',
        appId: 'app-one',
        taskId: 'request-mcp-connect-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          name: 'github',
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-github'],
          sandboxProfileId: 'sandbox:mcp-github',
          requestedToolPatterns: ['search_repositories'],
          credentialNeeds: ['GITHUB_TOKEN'],
          reason: 'Need repository search.',
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'request_mcp_server',
          title: 'Connect MCP source for this agent',
          toolInput: expect.objectContaining({
            name: 'github',
            transport: 'stdio_template',
            sandboxProfileId: 'sandbox:mcp-github',
            activation: 'source_inventory_only',
          }),
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Connected MCP source github'),
        { threadId: 'thread-origin' },
      );
    });
    expect([...state.mcpServers.servers.values()]).toEqual([
      expect.objectContaining({
        name: 'github',
        status: 'active',
        createdSource: 'agent_request',
        config: expect.objectContaining({
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-github'],
        }),
        sandboxProfileId: 'sandbox:mcp-github',
      }),
    ]);
    expect([...state.mcpServers.bindings.values()]).toEqual([
      expect.objectContaining({
        agentId: 'agent:one',
        status: 'active',
      }),
    ]);
  });
});
