import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { startTestControlServer } from '../harness/control-http-server.js';
import { createClient } from '../../../../packages/sdk/src/index.js';
import {
  AgentMcpServerBindingResponseSchema,
  McpServerDefinitionResponseSchema,
} from '@myclaw/contracts';

import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpServerAuditEvent,
  McpServerDefinition,
  McpServerId,
  McpServerVersion,
  McpServerVersionId,
} from '@core/domain/mcp/mcp-servers.js';
import type { McpServerRepository } from '@core/domain/ports/repositories.js';

class InMemoryMcpServerRepository implements McpServerRepository {
  servers = new Map<string, McpServerDefinition>();
  versions = new Map<string, McpServerVersion>();
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

  async getVersion(id: McpServerVersionId) {
    return this.versions.get(id) ?? null;
  }

  async listVersions(serverId: McpServerId) {
    return [...this.versions.values()]
      .filter((version) => version.serverId === serverId)
      .sort((left, right) => right.version - left.version);
  }

  async saveVersion(version: McpServerVersion) {
    this.versions.set(version.id, version);
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
    const binding = this.bindings.get(key);
    if (!binding) return null;
    const disabled = {
      ...binding,
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
          (!input.cursor || binding.createdAt < input.cursor),
      )
      .slice(0, input.limit ?? 100);
  }

  async listMaterializedServersForAgent(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<MaterializedMcpServer[]> {
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.appId === input.appId &&
          binding.agentId === input.agentId &&
          binding.status === 'active',
      )
      .map((binding) => ({
        binding,
        definition: this.servers.get(binding.serverId)!,
        version: this.versions.get(binding.versionId)!,
      }))
      .filter((record) => record.definition?.status === 'approved');
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
  MYCLAW_HOME: '/tmp/myclaw-mcp-integration-home',
  DATA_DIR: '/tmp/myclaw-mcp-integration-home/data',
  MYCLAW_IPC_AUTH_SECRET: 'test-ipc-secret',
  ONECLI_ALLOWED_ENV_KEYS: [],
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isSchedulerReady: vi.fn(() => true),
  runtimeJobSchedulePlanner: {
    createManualJobId: () => 'job-test',
    createJobId: () => 'job-test',
    planAppSchedule: () => ({
      scheduleType: 'manual',
      scheduleValue: 'manual',
      nextRun: null,
    }),
    planInitial: () => ({ nextRun: '2026-04-24T01:00:00.000Z' }),
    planResume: ({ job, clock }) =>
      job.next_run ??
      (job.schedule_type === 'manual'
        ? null
        : job.schedule_type === 'once'
          ? job.schedule_value
          : clock.now()),
  },
  requestSchedulerSync: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => {
  const agentsRepo = {
    getAgent: vi.fn(async (agentId: string) => {
      if (agentId === 'agent:one') {
        return {
          id: agentId,
          appId: 'app-one',
          name: 'Agent One',
          status: 'active',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      }
      if (agentId === 'agent:other') {
        return {
          id: agentId,
          appId: 'app-two',
          name: 'Other Agent',
          status: 'active',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      }
      return null;
    }),
  };
  return {
    getRuntimeControlRepository: () => ({
      listDueWebhookDeliveries: vi.fn(async () => []),
      claimDueWebhookDeliveries: vi.fn(async () => []),
    }),
    getRuntimeOpsRepository: () => ({
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    }),
    getRuntimeStorage: () => ({
      repositories: { agents: agentsRepo, mcpServers: state.mcpServers },
    }),
  };
});

describe('MCP server management integration flow', () => {
  beforeEach(() => {
    state.mcpServers = new InMemoryMcpServerRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates, approves, binds, materializes, and disables an admin-managed MCP server through control SDK and services', async () => {
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
      const created = await client.mcpServers.drafts.create({
        name: 'github',
        displayName: 'GitHub MCP',
        transport: 'http',
        config: {
          transport: 'http',
          url: 'https://93.184.216.34/github',
        },
        credentialRefs: [
          { name: 'GITHUB_TOKEN_REF', target: 'header', key: 'Authorization' },
        ],
        allowedToolPatterns: ['search_repositories'],
        autoApproveToolPatterns: ['search_repositories'],
        createdBy: 'admin-user',
      });
      const draft = McpServerDefinitionResponseSchema.parse(
        (created as any).server,
      );
      expect(draft).toMatchObject({
        appId: 'app-one',
        name: 'github',
        status: 'draft',
        createdSource: 'admin',
      });

      const approved = await client.mcpServers.drafts.approve(draft.id, {
        approvedBy: 'reviewer',
      });
      expect((approved as any).server.status).toBe('approved');
      const testResult = await client.mcpServers.test(draft.id, {
        testedBy: 'reviewer',
      });
      expect((testResult as any).ok).toBe(true);

      const binding = await client.agents.mcpServers.enable(
        'agent:one',
        draft.id,
        {
          required: true,
        },
      );
      const parsedBinding = AgentMcpServerBindingResponseSchema.parse(
        (binding as any).binding,
      );
      expect(parsedBinding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        serverId: draft.id,
        status: 'active',
        required: true,
      });

      const { McpServerService } =
        await import('@core/application/mcp/mcp-server-service.js');
      const materialized = await new McpServerService(
        state.mcpServers,
      ).materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        credentialEnv: { GITHUB_TOKEN_REF: 'broker-safe-token' },
      });
      expect(materialized).toEqual([
        {
          name: 'github',
          config: {
            type: 'http',
            url: 'https://93.184.216.34/github',
            headers: { Authorization: 'broker-safe-token' },
          },
          allowedToolPatterns: ['search_repositories'],
          allowedToolNames: ['mcp__github__search_repositories'],
          autoApproveToolPatterns: ['search_repositories'],
          autoApproveToolNames: ['mcp__github__search_repositories'],
          required: true,
        },
      ]);

      const disabled = await client.agents.mcpServers.disable(
        'agent:one',
        draft.id,
      );
      expect((disabled as any).disabled).toBe(true);
      await expect(
        new McpServerService(state.mcpServers).materializeForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
        }),
      ).resolves.toEqual([]);
      expect(
        state.mcpServers.auditEvents.map((event) => event.eventType),
      ).toEqual(
        expect.arrayContaining([
          'request',
          'approve',
          'test',
          'bind',
          'materialize',
          'unbind',
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it('fails closed when an approved MCP credential ref is not brokered', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const service = new McpServerService(state.mcpServers);

    const draft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'missing_credential',
      transportConfig: {
        transport: 'http',
        url: 'https://93.184.216.34/missing-credential',
      },
      credentialRefs: [
        {
          name: 'MISSING_TOKEN_REF',
          target: 'header',
          key: 'Authorization',
        },
      ],
      createdBy: 'admin-user',
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: draft.definition.id,
      approvedBy: 'reviewer',
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
    });

    await expect(
      service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        credentialEnv: {},
      }),
    ).rejects.toThrow(/Missing broker credential/);
  });

  it('enforces stored MCP allowed tool patterns and validates auto-approval scope', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const service = new McpServerService(state.mcpServers);

    await expect(
      service.createDraft({
        appId: 'app-one' as never,
        name: 'bad_tool_scope',
        transportConfig: {
          transport: 'http',
          url: 'https://93.184.216.34/bad-tool-scope',
        },
        allowedToolPatterns: ['read_issue'],
        autoApproveToolPatterns: ['write_issue'],
      }),
    ).rejects.toThrow(/also be listed in allowedToolPatterns/);

    const draft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'tool_scope',
      transportConfig: {
        transport: 'http',
        url: 'https://93.184.216.34/tool-scope',
      },
      allowedToolPatterns: ['read_issue'],
      autoApproveToolPatterns: ['read_issue'],
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: draft.definition.id,
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
    });

    await expect(
      service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'tool_scope',
        allowedToolNames: ['mcp__tool_scope__read_issue'],
        autoApproveToolNames: ['mcp__tool_scope__read_issue'],
      }),
    ]);
  });

  it('allows only a safe package argument for the npx stdio template', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const service = new McpServerService(state.mcpServers);

    await expect(
      service.createDraft({
        appId: 'app-one' as never,
        name: 'bad_npx',
        transportConfig: {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['--package=unsafe'],
        },
        sandboxProfileId: 'sandbox:approved',
      }),
    ).rejects.toThrow(/safe npm package argument/);

    const draft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'safe_npx',
      transportConfig: {
        transport: 'stdio_template',
        templateId: 'npx-package',
        args: ['@modelcontextprotocol/server-github'],
      },
      sandboxProfileId: 'sandbox:approved',
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: draft.definition.id,
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
    });

    await expect(
      service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'safe_npx',
        config: expect.objectContaining({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        }),
      }),
    ]);
  });

  it('preserves existing binding policies when same-channel rebind omits policies', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const service = new McpServerService(state.mcpServers);
    const draft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'policy_preserve',
      transportConfig: {
        transport: 'http',
        url: 'https://93.184.216.34/policy-preserve',
      },
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: draft.definition.id,
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
      permissionPolicyIds: ['policy:admin-reviewed'] as never,
    });
    await service.unbindFromAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
    });

    const rebound = await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
    });

    expect(rebound.permissionPolicyIds).toEqual(['policy:admin-reviewed']);
  });

  it('does not disable draft or rejected MCP servers through the disable path', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const service = new McpServerService(state.mcpServers);
    const draft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'disable_draft',
      transportConfig: {
        transport: 'http',
        url: 'https://93.184.216.34/disable-draft',
      },
    });

    await expect(
      service.disableServer({
        appId: 'app-one' as never,
        serverId: draft.definition.id,
      }),
    ).rejects.toThrow(/Only approved/);

    await service.rejectDraft({
      appId: 'app-one' as never,
      serverId: draft.definition.id,
      reason: 'not needed',
    });
    await expect(
      service.disableServer({
        appId: 'app-one' as never,
        serverId: draft.definition.id,
      }),
    ).rejects.toThrow(/Only approved/);
  });

  it('skips optional MCP DNS materialization failures and audits them', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const lookupHostname = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const service = new McpServerService(state.mcpServers, undefined, {
      lookupHostname,
    });
    const optionalDraft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'optional_bad_dns',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.optional.example/optional',
      },
    });
    const validDraft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'valid_dns',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.valid.example/valid',
      },
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: optionalDraft.definition.id,
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: validDraft.definition.id,
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: optionalDraft.definition.id,
      required: false,
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: validDraft.definition.id,
      required: false,
    });

    await expect(
      service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'valid_dns',
      }),
    ]);
    expect(
      state.mcpServers.auditEvents.filter(
        (event) => event.eventType === 'startup_failure',
      ),
    ).toHaveLength(1);
  });

  it('tests approved stdio template MCP servers with the stored sandbox profile', async () => {
    const server = await startTestControlServer({
      token: 'token-mcp',
      appId: 'app-one',
      scopes: ['mcp:read', 'mcp:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const created = await client.mcpServers.drafts.create({
        name: 'local-helper',
        transport: 'stdio_template',
        config: {
          transport: 'stdio_template',
          templateId: 'node-script',
        },
        sandboxProfileId: 'sandbox:approved',
        createdBy: 'admin-user',
      });
      const draft = McpServerDefinitionResponseSchema.parse(
        (created as any).server,
      );
      await client.mcpServers.drafts.approve(draft.id, {
        approvedBy: 'reviewer',
      });

      const testResult = await client.mcpServers.test(draft.id, {
        testedBy: 'reviewer',
      });
      expect((testResult as any).ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('blocks cross-app binding and raw-secret MCP config', async () => {
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
      await expect(
        client.mcpServers.drafts.create({
          name: 'bad',
          transport: 'http',
          config: {
            transport: 'http',
            url: 'https://93.184.216.34/bad',
            headers: { Authorization: 'Bearer real-secret-token' },
          },
        }),
      ).rejects.toThrow(/raw secret/i);
      await expect(
        client.mcpServers.drafts.create({
          name: 'private_net',
          transport: 'http',
          config: {
            transport: 'http',
            url: 'https://127.0.0.1:9999/private',
          },
        }),
      ).rejects.toThrow(/private|loopback|metadata/i);
      await expect(
        client.mcpServers.drafts.create({
          name: 'plain_http',
          transport: 'http',
          config: {
            transport: 'http',
            url: 'http://mcp.example.test/plain',
          },
        }),
      ).rejects.toThrow(/https/i);
      await expect(
        client.mcpServers.drafts.create({
          name: 'raw_env_ref',
          transport: 'http',
          config: {
            transport: 'http',
            url: 'https://93.184.216.34/raw-env',
          },
          credentialRefs: [
            { name: 'OPENAI_API_KEY', target: 'header', key: 'Authorization' },
          ],
        }),
      ).rejects.toThrow(/broker-scoped/i);

      const created = await client.mcpServers.drafts.create({
        name: 'linear',
        transport: 'sse',
        config: { transport: 'sse', url: 'https://93.184.216.34/linear' },
      });
      const draft = (created as any).server;
      await client.mcpServers.drafts.approve(draft.id);

      await expect(
        client.agents.mcpServers.enable('agent:other', draft.id),
      ).rejects.toThrow(/Agent not found/);
    } finally {
      await server.close();
    }
  });

  it('records agent-requested MCP servers as pending drafts and rejects missing approval surfaces', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    await processTaskIpc(
      {
        type: 'request_mcp_server',
        taskId: 'request-mcp-test',
        targetJid: 'chat-1',
        chatJid: 'chat-1',
        payload: {
          name: 'github',
          transport: 'http',
          origin: 'https://93.184.216.34/github',
          requestedToolPatterns: ['search_repositories'],
          credentialNeeds: ['GITHUB_TOKEN_REF'],
          reason: 'Need repository search for triage.',
        },
      },
      'agent:one',
      false,
      {
        registeredGroups: () => ({
          'chat-1': {
            name: 'Agent One',
            folder: 'agent:one',
            jid: 'chat-1',
          } as any,
        }),
        syncGroups: vi.fn(async () => undefined),
        getAvailableGroups: vi.fn(async () => []),
        writeGroupsSnapshot: vi.fn(async () => undefined),
      } as any,
    );

    const drafts = await state.mcpServers.listServers({
      appId: 'default' as never,
      statuses: ['draft'],
    });
    expect(drafts).toHaveLength(0);
  });

  it('does not reuse an existing agent-requested MCP draft with the same name', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const service = new McpServerService(state.mcpServers);
    const stale = await service.createDraft({
      appId: 'default' as never,
      name: 'github',
      createdBy: 'agent:other',
      createdSource: 'agent_request',
      requestedReason: 'Older request with different origin.',
      transportConfig: {
        transport: 'http',
        url: 'https://93.184.216.34/attacker',
      } as never,
      allowedToolPatterns: ['attacker_tool'],
      credentialRefs: [],
      riskClass: 'medium',
    });

    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    await processTaskIpc(
      {
        type: 'request_mcp_server',
        taskId: 'request-mcp-stale-draft-test',
        targetJid: 'chat-1',
        chatJid: 'chat-1',
        payload: {
          name: 'github',
          transport: 'http',
          origin: 'https://93.184.216.34/github',
          requestedToolPatterns: ['search_repositories'],
          reason: 'Need repository search for triage.',
        },
      },
      'agent:one',
      false,
      {
        registeredGroups: () => ({
          'chat-1': {
            name: 'Agent One',
            folder: 'agent:one',
            jid: 'chat-1',
          } as any,
        }),
        syncGroups: vi.fn(async () => undefined),
        getAvailableGroups: vi.fn(async () => []),
        writeGroupsSnapshot: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
        requestPermissionApproval,
        requestUserAnswer: vi.fn(),
        onSchedulerChanged: vi.fn(),
        registerGroup: vi.fn(),
      } as any,
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    await expect(
      state.mcpServers.listServers({
        appId: 'default' as never,
        statuses: ['draft'],
      }),
    ).resolves.toEqual([stale.definition]);
    await expect(
      state.mcpServers.listVersions(stale.definition.id),
    ).resolves.toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          url: 'https://93.184.216.34/attacker',
        }),
      }),
    ]);
  });

  it('binds agent-requested MCP servers only after approval and keeps rejection unmaterialized', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi
      .fn()
      .mockResolvedValueOnce({
        approved: false,
        decidedBy: 'Approver',
        reason: 'not needed',
      })
      .mockResolvedValueOnce({
        approved: true,
        decidedBy: 'Approver',
        reason: 'approved',
      });
    const deps = {
      registeredGroups: () => ({
        'chat-1': {
          name: 'Agent One',
          folder: 'agent:one',
          jid: 'chat-1',
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
        taskId: 'request-mcp-reject-test',
        targetJid: 'chat-1',
        chatJid: 'chat-1',
        payload: {
          name: 'linear',
          transport: 'sse',
          origin: 'https://93.184.216.34/linear',
          requestedToolPatterns: ['search_issues'],
          credentialNeeds: ['LINEAR_TOKEN_REF'],
          reason: 'Need issue search for triage.',
        },
      },
      'agent:one',
      false,
      deps as any,
    );
    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    });
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    await expect(
      new McpServerService(state.mcpServers).materializeForAgent({
        appId: 'default' as never,
        agentId: 'agent:one' as never,
      }),
    ).resolves.toEqual([]);
    await expect(
      state.mcpServers.listServers({
        appId: 'default' as never,
        statuses: ['rejected'],
      }),
    ).resolves.toHaveLength(1);

    await processTaskIpc(
      {
        type: 'request_mcp_server',
        taskId: 'request-mcp-approve-test',
        targetJid: 'chat-1',
        chatJid: 'chat-1',
        payload: {
          name: 'github',
          transport: 'http',
          origin: 'https://93.184.216.34/github',
          requestedToolPatterns: ['search_repositories'],
          credentialNeeds: ['GITHUB_TOKEN_REF'],
          reason: 'Need repository search for triage.',
        },
      },
      'agent:one',
      false,
      deps as any,
    );
    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledTimes(2);
    });

    await vi.waitFor(async () => {
      await expect(
        state.mcpServers.listServers({
          appId: 'default' as never,
          statuses: ['draft'],
        }),
      ).resolves.toHaveLength(0);
    });
    const approved = await state.mcpServers.listServers({
      appId: 'default' as never,
      statuses: ['approved'],
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      name: 'github',
      createdSource: 'agent_request',
      status: 'approved',
    });

    await expect(
      new McpServerService(state.mcpServers).materializeForAgent({
        appId: 'default' as never,
        agentId: 'agent:one' as never,
        credentialEnv: { MCP_GITHUB_GITHUB_TOKEN_REF: 'broker-safe-token' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'github',
        config: expect.objectContaining({
          headers: { Authorization: 'broker-safe-token' },
        }),
        required: false,
      }),
    ]);
    expect(sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Approved MCP server github'),
      undefined,
    );
  });

  it('routes agent-requested MCP approval only to the originating registered chat', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    const deps = {
      registeredGroups: () => ({
        'chat-wrong': {
          name: 'Agent One Wrong',
          folder: 'agent:one',
          jid: 'chat-wrong',
        } as any,
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
        taskId: 'request-mcp-origin-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          name: 'jira',
          transport: 'http',
          origin: 'https://93.184.216.34/jira',
          requestedToolPatterns: ['search_issues'],
          credentialNeeds: ['JIRA_TOKEN_REF'],
          reason: 'Need issue search in this channel.',
        },
      },
      'agent:one',
      false,
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    });
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceGroup: 'agent:one',
        targetJid: 'chat-origin',
        threadId: 'thread-origin',
        decisionPolicy: 'same_channel',
      }),
    );
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Approved MCP server jira'),
        { threadId: 'thread-origin' },
      );
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      'chat-wrong',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects agent-requested MCP approval target overrides', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
    }));
    const deps = {
      registeredGroups: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
        'chat-admin-dm': {
          name: 'Agent One Admin DM',
          folder: 'agent:one',
          jid: 'chat-admin-dm',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_mcp_server',
        taskId: 'request-mcp-forum-shopping-test',
        chatJid: 'chat-origin',
        targetJid: 'chat-admin-dm',
        payload: {
          name: 'forum-shop',
          transport: 'http',
          origin: 'https://93.184.216.34/forum-shop',
          reason: 'Try routing to another bound chat.',
        },
      },
      'agent:one',
      false,
      deps as any,
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    await expect(
      state.mcpServers.listServers({
        appId: 'default' as never,
        statuses: ['draft', 'approved', 'rejected'],
      }),
    ).resolves.toHaveLength(0);
  });

  it('rejects agent-requested MCP approval when the originating chat is absent or unbound', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
    }));
    const deps = {
      registeredGroups: () => ({
        'chat-1': {
          name: 'Agent One',
          folder: 'agent:one',
          jid: 'chat-1',
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
        taskId: 'request-mcp-unbound-chat-test',
        targetJid: 'chat-other',
        chatJid: 'chat-other',
        payload: {
          name: 'bad-origin',
          transport: 'http',
          origin: 'https://93.184.216.34/bad-origin',
          reason: 'Try routing outside the origin.',
        },
      },
      'agent:one',
      false,
      deps as any,
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(
      state.mcpServers.listServers({
        appId: 'default' as never,
        statuses: ['draft', 'approved', 'rejected'],
      }),
    ).resolves.toHaveLength(0);
  });

  it('rejects remote MCP hosts that resolve to private networks at approval and materialization time', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const lookupHostname = vi
      .fn()
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: 'fc00::1', family: 6 }]);
    const service = new McpServerService(state.mcpServers, undefined, {
      lookupHostname,
      dnsValidationCache: undefined,
    });

    const privateDraft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'private_dns',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.attacker.example/private',
      },
      createdBy: 'admin-user',
    });
    await expect(
      service.approveDraft({
        appId: 'app-one' as never,
        serverId: privateDraft.definition.id,
        approvedBy: 'reviewer',
      }),
    ).rejects.toThrow(/public routable|resolve/i);

    const rebindingDraft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'rebind_dns',
      transportConfig: {
        transport: 'sse',
        url: 'https://mcp.rebind.example/sse',
      },
      createdBy: 'admin-user',
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: rebindingDraft.definition.id,
      approvedBy: 'reviewer',
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: rebindingDraft.definition.id,
      required: true,
    });
    await expect(
      service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
      }),
    ).rejects.toThrow(/public routable|resolve/i);
    expect(lookupHostname).toHaveBeenCalledTimes(3);
  });

  it('caches successful remote MCP DNS validation for repeated materialization', async () => {
    const { McpServerService } =
      await import('@core/application/mcp/mcp-server-service.js');
    const { RemoteMcpDnsValidationCache } =
      await import('@core/application/mcp/mcp-server-policy.js');
    const lookupHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    const service = new McpServerService(state.mcpServers, undefined, {
      lookupHostname,
      dnsValidationCache: new RemoteMcpDnsValidationCache(),
      auditMaterialization: false,
    });

    const draft = await service.createDraft({
      appId: 'app-one' as never,
      name: 'cached_dns',
      transportConfig: {
        transport: 'http',
        url: 'https://mcp.cached.example/http',
      },
      createdBy: 'admin-user',
    });
    await service.approveDraft({
      appId: 'app-one' as never,
      serverId: draft.definition.id,
      approvedBy: 'reviewer',
    });
    await service.bindToAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
      serverId: draft.definition.id,
    });

    await service.materializeForAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
    });
    await service.materializeForAgent({
      appId: 'app-one' as never,
      agentId: 'agent:one' as never,
    });

    expect(lookupHostname).toHaveBeenCalledTimes(1);
    expect(
      state.mcpServers.auditEvents.map((event) => event.eventType),
    ).not.toContain('materialize');
  });
});
