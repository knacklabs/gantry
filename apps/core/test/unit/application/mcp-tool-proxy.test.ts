import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import {
  createGuardedMcpFetch,
  McpToolProxy,
  projectMcpProxyCallerIdentity,
} from '@core/application/mcp/mcp-tool-proxy.js';
import type { MaterializedMcpCapability } from '@core/application/mcp/mcp-server-service.js';
import type { McpServerRepository } from '@core/domain/ports/repositories.js';
import { CUSTOMER_IDENTITY_MISMATCH_MESSAGE } from '@core/shared/user-visible-messages.js';

type PendingMcpCall = {
  name: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type MockMcpClient = {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
};

const sdkMocks = vi.hoisted(() => ({
  clients: [] as MockMcpClient[],
  pendingCalls: [] as PendingMcpCall[],
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function MockClient() {
    const client: MockMcpClient = {
      closed: false,
      close: vi.fn(async () => {
        client.closed = true;
      }),
      connect: vi.fn(async () => undefined),
      callTool: vi.fn(
        (input: { name: string }) =>
          new Promise((resolve, reject) => {
            sdkMocks.pendingCalls.push({
              name: input.name,
              resolve,
              reject,
            });
          }),
      ),
      listTools: vi.fn(async () => ({ tools: [] })),
    };
    sdkMocks.clients.push(client);
    return client;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi
    .fn()
    .mockImplementation(function MockStreamableHTTPClientTransport() {
      return {};
    }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi
    .fn()
    .mockImplementation(function MockSSEClientTransport() {
      return {};
    }),
}));

const TEST_SECRET = 'test_secret_thirty_two_bytes_long_xx';

function httpCap(
  overrides: Partial<MaterializedMcpCapability> = {},
): MaterializedMcpCapability {
  return {
    name: 'shopify-api',
    callerIdentity: {
      mode: 'required',
      headerName: 'X-Caller-Identity',
      signingRef: 'MCP_IDENTITY_SECRET',
      source: { kind: 'conversation_jid_phone', jidPrefix: 'wa:' },
    },
    config: { type: 'http', url: 'http://127.0.0.1:8081/mcp' },
    allowedToolPatterns: ['get_*'],
    autoApproveToolPatterns: ['get_*'],
    allowedToolNames: [],
    autoApproveToolNames: [],
    required: false,
    ...overrides,
  };
}

describe('createGuardedMcpFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sdkMocks.clients.length = 0;
    sdkMocks.pendingCalls.length = 0;
  });

  it('rejects hostname fetches until MCP proxy has DNS-pinned transport', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      createGuardedMcpFetch({ lookupHostname })(
        'https://mcp.example.test/tools',
      ),
    ).rejects.toThrow('DNS-pinned transport');

    expect(lookupHostname).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows public IP-literal URLs through public-address validation', async () => {
    const lookupHostname = vi.fn();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await createGuardedMcpFetch({ lookupHostname })(
      'https://93.184.216.34/tools',
    );

    expect(lookupHostname).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://93.184.216.34/tools',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});

describe('McpToolProxy', () => {
  afterEach(() => {
    sdkMocks.clients.length = 0;
    sdkMocks.pendingCalls.length = 0;
    vi.restoreAllMocks();
  });

  it('keeps a shared MCP client open while another concurrent call is still running', async () => {
    const repository = mcpRepositoryForProxyTest();
    const proxy = new McpToolProxy(repository, {
      tools: {} as never,
      credentialEnv: {},
    });
    const baseInput = {
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      serverName: 'shopify-api',
    };

    const slow = proxy.callTool({
      ...baseInput,
      toolName: 'get_slow',
      arguments: {},
    });
    await vi.waitFor(() => expect(sdkMocks.pendingCalls).toHaveLength(1));

    const fast = proxy.callTool({
      ...baseInput,
      toolName: 'get_fast',
      arguments: {},
    });
    await vi.waitFor(() => expect(sdkMocks.pendingCalls).toHaveLength(2));

    const fastCall = sdkMocks.pendingCalls.find(
      (call) => call.name === 'get_fast',
    );
    expect(fastCall).toBeDefined();
    fastCall!.resolve({ content: [] });
    await expect(fast).resolves.toEqual({ content: [] });

    expect(sdkMocks.clients).toHaveLength(1);
    expect(sdkMocks.clients[0]!.close).not.toHaveBeenCalled();

    const slowCall = sdkMocks.pendingCalls.find(
      (call) => call.name === 'get_slow',
    );
    expect(slowCall).toBeDefined();
    slowCall!.resolve({ content: [] });
    await expect(slow).resolves.toEqual({ content: [] });
    await vi.waitFor(() =>
      expect(sdkMocks.clients[0]!.close).toHaveBeenCalled(),
    );
  });

  it('does not reject the tool call when idle MCP client close fails', async () => {
    const repository = mcpRepositoryForProxyTest();
    const proxy = new McpToolProxy(repository, {
      tools: {} as never,
      credentialEnv: {},
    });

    const call = proxy.callTool({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      serverName: 'shopify-api',
      toolName: 'get_products',
      arguments: {},
    });
    await vi.waitFor(() => expect(sdkMocks.pendingCalls).toHaveLength(1));
    sdkMocks.clients[0]!.close.mockRejectedValueOnce(new Error('close failed'));
    sdkMocks.pendingCalls[0]!.resolve({ content: [] });

    await expect(call).resolves.toEqual({ content: [] });
    await vi.waitFor(() =>
      expect(sdkMocks.clients[0]!.close).toHaveBeenCalled(),
    );
  });
});

describe('projectMcpProxyCallerIdentity', () => {
  it('injects signed caller identity headers for Gantry MCP proxy calls', () => {
    const [capability] = projectMcpProxyCallerIdentity({
      capabilities: [httpCap()],
      callerIdentityJid: 'wa:919654405340',
      credentialEnv: { MCP_IDENTITY_SECRET: TEST_SECRET },
    });

    expect(capability?.config.type).toBe('http');
    expect(
      (capability?.config as { headers?: Record<string, string> }).headers?.[
        'X-Caller-Identity'
      ],
    ).toMatch(/^phone:\+919654405340;ts:\d+;sig:[0-9a-f]+$/);
  });

  it('does not restrict admin/operator proxy calls when caller identity is disabled', () => {
    const input = httpCap({ callerIdentity: undefined });

    const [capability] = projectMcpProxyCallerIdentity({
      capabilities: [input],
      credentialEnv: {},
    });

    expect(capability).toEqual(input);
  });

  it('can resolve caller identity per MCP server', () => {
    const [shopify, crm] = projectMcpProxyCallerIdentity({
      capabilities: [
        httpCap({ name: 'shopify-api' }),
        httpCap({
          name: 'boondi-crm',
          config: { type: 'http', url: 'http://127.0.0.1:8082/mcp' },
        }),
      ],
      callerIdentityJid: 'wa:000000050',
      callerIdentityJidForCapability: (capability) =>
        capability.name === 'shopify-api' ? 'wa:918097288633' : 'wa:000000050',
      credentialEnv: { MCP_IDENTITY_SECRET: TEST_SECRET },
    });

    expect(
      (shopify?.config as { headers?: Record<string, string> }).headers?.[
        'X-Caller-Identity'
      ],
    ).toMatch(/^phone:\+918097288633;ts:\d+;sig:[0-9a-f]+$/);
    expect(
      (crm?.config as { headers?: Record<string, string> }).headers?.[
        'X-Caller-Identity'
      ],
    ).toMatch(/^phone:\+000000050;ts:\d+;sig:[0-9a-f]+$/);
  });

  it('returns only customer-safe wording when proxy identity projection fails', () => {
    expect(() =>
      projectMcpProxyCallerIdentity({
        capabilities: [httpCap()],
        callerIdentityJid: 'tg:-123',
        credentialEnv: { MCP_IDENTITY_SECRET: TEST_SECRET },
      }),
    ).toThrow(ApplicationError);

    try {
      projectMcpProxyCallerIdentity({
        capabilities: [httpCap()],
        callerIdentityJid: 'tg:-123',
        credentialEnv: { MCP_IDENTITY_SECRET: TEST_SECRET },
      });
    } catch (err) {
      expect(err).toMatchObject({
        message: CUSTOMER_IDENTITY_MISMATCH_MESSAGE,
      });
      expect(err instanceof ApplicationError ? err.details : []).toEqual([
        expect.stringContaining('wa: conversation identity'),
      ]);
      expect(err instanceof Error ? err.message : String(err)).not.toMatch(
        /Gantry|MCP|credential|header|admin|configuration|secret|privacy guard|signed channel|Shopify Admin|bypass/i,
      );
    }
  });
});

function mcpRepositoryForProxyTest(): McpServerRepository {
  const now = '2026-06-17T00:00:00.000Z' as never;
  const definition = {
    id: 'mcp:shopify-api' as never,
    appId: 'app:test' as never,
    name: 'shopify-api',
    status: 'active',
    createdSource: 'admin',
    riskClass: 'medium',
    transport: 'http',
    config: {
      transport: 'http',
      url: 'http://127.0.0.1:18081/mcp',
    },
    allowedToolPatterns: ['get_*'],
    autoApproveToolPatterns: ['get_*'],
    credentialRefs: [],
    createdAt: now,
    updatedAt: now,
  };
  const binding = {
    id: 'binding:shopify-api' as never,
    appId: 'app:test' as never,
    agentId: 'agent:test' as never,
    serverId: definition.id,
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    getServer: vi.fn(async () => definition),
    getServerByName: vi.fn(async () => definition),
    listServers: vi.fn(async () => [definition]),
    saveServer: vi.fn(async () => undefined),
    transitionServerStatus: vi.fn(async () => definition),
    saveAgentBinding: vi.fn(async () => undefined),
    disableAgentBinding: vi.fn(async () => binding),
    listAgentBindings: vi.fn(async () => [binding]),
    listAgentBindingsForAgents: vi.fn(async () => [binding]),
    listMaterializedServersForAgent: vi.fn(async () => [
      { definition, binding },
    ]),
    appendAuditEvent: vi.fn(async () => undefined),
    listAuditEvents: vi.fn(async () => []),
  };
}
