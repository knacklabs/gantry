import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mcpSdkMocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(async () => undefined),
    callTool: vi.fn(async () => ({ content: [] })),
    listTools: vi.fn(async () => ({ tools: [] })),
    close: vi.fn(async () => undefined),
  };
  return {
    client,
    Client: vi.fn(function Client() {
      return client;
    }),
    StreamableHTTPClientTransport: vi.fn(
      function StreamableHTTPClientTransport() {},
    ),
    SSEClientTransport: vi.fn(function SSEClientTransport() {}),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mcpSdkMocks.Client,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mcpSdkMocks.StreamableHTTPClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mcpSdkMocks.SSEClientTransport,
}));

import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
  McpToolProxy,
} from '@core/application/mcp/mcp-tool-proxy.js';
import { resolvePinnedPublicMcpAddress } from '@core/shared/dns-pinned-fetch.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

beforeEach(() => {
  // Re-establish constructor implementations so the SDK client/transport mocks
  // stay newable regardless of mock clearing or cross-file state at full-suite
  // scale (a bare cleared vi.fn() implementation is not a constructor).
  mcpSdkMocks.Client.mockImplementation(function Client() {
    return mcpSdkMocks.client;
  });
  mcpSdkMocks.StreamableHTTPClientTransport.mockImplementation(
    function StreamableHTTPClientTransport() {},
  );
  mcpSdkMocks.SSEClientTransport.mockImplementation(
    function SSEClientTransport() {},
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    vi.useRealTimers();
  }
  vi.clearAllMocks();
});

describe('resolvePinnedPublicMcpAddress', () => {
  it('pins a public IP literal without resolving', async () => {
    const lookupHostname = vi.fn();
    await expect(
      resolvePinnedPublicMcpAddress('93.184.216.34', lookupHostname),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    expect(lookupHostname).not.toHaveBeenCalled();
  });

  it('rejects a private IP literal', async () => {
    await expect(
      resolvePinnedPublicMcpAddress('127.0.0.1', vi.fn()),
    ).rejects.toThrow(/public and routable/);
  });

  it('pins a bracketed public IPv6 literal to the bare address', async () => {
    await expect(
      resolvePinnedPublicMcpAddress('[2606:4700:4700::1111]', vi.fn()),
    ).resolves.toEqual({ address: '2606:4700:4700::1111', family: 6 });
  });

  it('resolves a hostname and pins the validated public address', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    await expect(
      resolvePinnedPublicMcpAddress('mcp.example.test', lookupHostname),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    expect(lookupHostname).toHaveBeenCalledWith('mcp.example.test');
  });

  it('fails closed when any resolved record is private (rebinding guard)', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.5', family: 4 as const },
    ]);
    await expect(
      resolvePinnedPublicMcpAddress('mcp.example.test', lookupHostname),
    ).rejects.toThrow(/only to public routable addresses/);
  });

  it('fails closed for a hostname with no resolver available', async () => {
    await expect(
      resolvePinnedPublicMcpAddress('mcp.example.test'),
    ).rejects.toThrow(/did not resolve to a public address/);
  });
});

describe('createGuardedMcpFetch', () => {
  it('pins via DNS and fails closed on private resolution before any socket', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '127.0.0.1', family: 4 as const },
    ]);
    await expect(
      createGuardedMcpFetch({ lookupHostname })(
        'https://mcp.example.test/tools',
      ),
    ).rejects.toThrow(/only to public routable addresses/);
    expect(lookupHostname).toHaveBeenCalledWith('mcp.example.test');
  });

  it('destroys the pinned request when the caller aborts', async () => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    request.destroy = vi.fn(() => request);
    request.end = vi.fn();
    request.write = vi.fn();
    const requestSpy = vi
      .spyOn(http, 'request')
      .mockImplementation(() => request as never);
    try {
      const controller = new AbortController();
      const promise = createGuardedMcpFetch({
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      })('http://mcp.example.test/tools', { signal: controller.signal });
      await vi.waitFor(() => expect(requestSpy).toHaveBeenCalled());

      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(request.destroy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'AbortError' }),
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('aborts a stalled DNS lookup before opening a pinned socket', async () => {
    const lookupHostname = vi.fn(
      () => new Promise<Array<{ address: string; family: 4 | 6 }>>(() => {}),
    );
    const requestSpy = vi.spyOn(http, 'request');
    try {
      const controller = new AbortController();
      const promise = createGuardedMcpFetch({ lookupHostname })(
        'http://mcp.example.test/tools',
        { signal: controller.signal },
      );
      expect(lookupHostname).toHaveBeenCalledWith('mcp.example.test');

      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('times out a stalled DNS lookup before opening a pinned socket', async () => {
    vi.useFakeTimers();
    const lookupHostname = vi.fn(
      () => new Promise<Array<{ address: string; family: 4 | 6 }>>(() => {}),
    );
    const requestSpy = vi.spyOn(http, 'request');
    try {
      const promise = createGuardedMcpFetch({ lookupHostname })(
        'http://mcp.example.test/tools',
      );
      expect(lookupHostname).toHaveBeenCalledWith('mcp.example.test');
      const assertion = expect(promise).rejects.toThrow(
        /Remote MCP transport request timed out/,
      );

      await vi.advanceTimersByTimeAsync(60_000);

      await assertion;
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('does not destroy an active remote MCP stream at the setup timeout', async () => {
    vi.useFakeTimers();
    const request = new EventEmitter() as EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    request.destroy = vi.fn(() => request);
    request.end = vi.fn();
    request.write = vi.fn();
    const response = new Readable({ read() {} }) as http.IncomingMessage;
    response.statusCode = 200;
    response.headers = {};
    const requestSpy = vi
      .spyOn(http, 'request')
      .mockImplementation((_target, _options, callback) => {
        queueMicrotask(() => callback?.(response));
        return request as never;
      });
    try {
      const promise = createGuardedMcpFetch({
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      })('http://mcp.example.test/sse');

      await expect(promise).resolves.toBeInstanceOf(Response);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(request.destroy).not.toHaveBeenCalled();
      response.destroy();
    } finally {
      requestSpy.mockRestore();
    }
  });
});

describe('assertMcpNetworkHostAllowed', () => {
  it('allows a declared host', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://api.github.com/mcp',
        networkHosts: ['api.github.com:443'],
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('allows an undeclared host because MCP networkHosts are metadata', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://api.github.com:8443/mcp',
        networkHosts: ['api.github.com:443'],
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('allows an explicit non-default port when it is not denylisted', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://api.github.com:80/mcp',
        networkHosts: ['api.github.com:443'],
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('allows an undeclared hostname when it is not denylisted', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://evil.example.com/mcp',
        networkHosts: ['api.github.com:443'],
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('lets the global denylist win over a declared host', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://api.github.com/mcp',
        networkHosts: ['api.github.com:443'],
        denylist: ['api.github.com'],
      }),
    ).toThrow(/matches the egress denylist/);
  });
});

describe('McpToolProxy', () => {
  it('lists discovery-only MCP source tools without granting execution', async () => {
    vi.useFakeTimers();
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [{ name: 'search_repositories' }, { name: 'create_issue' }],
    });
    const proxy = new McpToolProxy(
      mcpRepository({
        remote: true,
        definitionAllowedToolPatterns: [],
        definitionAutoApproveToolPatterns: [],
      }),
      {
        tools: emptyToolRepository(),
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );

    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
      }),
    ).resolves.toEqual({
      servers: [
        {
          name: 'github',
          tools: [{ name: 'search_repositories' }, { name: 'create_issue' }],
        },
      ],
    });
    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'search_repositories',
      }),
    ).rejects.toThrow('MCP server is not approved for this agent: github');
  });

  it('does not let source-level tool patterns authorize unreviewed actions', async () => {
    const proxy = new McpToolProxy(mcpRepository(), {
      tools: toolRepository(),
    });

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'delete_repository',
      }),
    ).rejects.toThrow(
      'MCP tool is not approved for this agent: mcp__github__delete_repository',
    );
  });

  it('honors run-local MCP tool approvals for the current call', async () => {
    vi.useFakeTimers();
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      }),
    ).resolves.toEqual({ content: [] });
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledWith(
      { name: 'create_issue', arguments: { title: 'Bug' } },
      undefined,
      { timeout: 60_000 },
    );
  });

  it('intersects reviewed actions with the per-agent source tool scope', async () => {
    const proxy = new McpToolProxy(
      mcpRepository({ bindingAllowedToolPatterns: ['read_*'] }),
      {
        tools: toolRepository(),
      },
    );

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(
      'MCP tool is not approved for this agent: mcp__github__create_issue',
    );
  });

  it('revalidates current network policy before reusing cached remote clients', async () => {
    vi.useFakeTimers();
    const denylist: string[] = [];
    const proxy = new McpToolProxy(mcpRepository(), {
      tools: toolRepository(),
      egressDenylist: denylist,
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });
    const connect = (
      proxy as unknown as {
        connect(
          capability: ReturnType<typeof remoteCapability>,
        ): Promise<unknown>;
      }
    ).connect.bind(proxy);
    const capability = remoteCapability(['api.github.com:443']);

    await connect(capability);

    await expect(connect(remoteCapability([]))).resolves.toBeTruthy();
    denylist.push('api.github.com');
    await expect(connect(capability)).rejects.toThrow(
      /matches the egress denylist/,
    );
    expect(mcpSdkMocks.Client).toHaveBeenCalledTimes(1);
  });
});

function mcpRepository(input?: {
  bindingAllowedToolPatterns?: string[];
  definitionAllowedToolPatterns?: string[];
  definitionAutoApproveToolPatterns?: string[];
  remote?: boolean;
}) {
  const definition = {
    id: 'mcp:github',
    appId: 'app-one',
    name: 'github',
    status: 'active',
    createdSource: 'admin',
    riskClass: 'medium',
    transport: input?.remote ? 'http' : 'stdio_template',
    config: input?.remote
      ? {
          transport: 'http',
          url: 'https://api.github.com/mcp',
        }
      : {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-github'],
        },
    allowedToolPatterns: input?.definitionAllowedToolPatterns ?? ['*'],
    autoApproveToolPatterns: input?.definitionAutoApproveToolPatterns ?? ['*'],
    credentialRefs: [],
    networkHosts: ['api.github.com:443'],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const binding = {
    id: 'agent-mcp-binding:github',
    appId: 'app-one',
    agentId: 'agent-one',
    serverId: 'mcp:github',
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns: input?.bindingAllowedToolPatterns ?? [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    listAgentBindings: async () => [binding],
    getServer: async (id: string) => (id === 'mcp:github' ? definition : null),
    listMaterializedServersForAgent: async () => [{ definition, binding }],
    appendAuditEvent: async () => {},
  } as never;
}

function emptyToolRepository() {
  return {
    listAgentToolBindings: async () => [],
    getTool: async () => null,
  } as never;
}

function toolRepository() {
  const tool = {
    id: 'tool:github-create-issue',
    appId: 'app-one',
    name: 'capability:github.create_issue',
    inputSchema: semanticCapabilityInputSchema({
      capabilityId: 'github.create_issue',
      displayName: 'GitHub create issue',
      category: 'mcp',
      risk: 'write',
      can: 'Create a GitHub issue.',
      cannot: 'Call unrelated GitHub MCP tools.',
      credentialSource: 'none',
      implementationBindings: [
        { kind: 'mcp_tool', mcpTool: 'mcp__github__create_issue' },
      ],
    }),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    listAgentToolBindings: async () => [
      {
        id: 'agent-tool-binding:github-create-issue',
        appId: 'app-one',
        agentId: 'agent-one',
        toolId: tool.id,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
    getTool: async (id: string) => (id === tool.id ? tool : null),
  } as never;
}

function remoteCapability(networkHosts: string[]) {
  return {
    name: 'github',
    config: {
      type: 'http' as const,
      url: 'https://api.github.com/mcp',
    },
    allowedToolPatterns: ['*'],
    autoApproveToolPatterns: ['*'],
    allowedToolNames: ['mcp__github__create_issue'],
    autoApproveToolNames: ['mcp__github__create_issue'],
    networkHosts,
    required: false,
  };
}
