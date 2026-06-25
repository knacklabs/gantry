import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
  clearMcpToolProxyInventoryCache,
  createGuardedMcpFetch,
  McpToolProxy,
} from '@core/application/mcp/mcp-tool-proxy.js';
import {
  fetchMcpToolListPages,
  MAX_MCP_REMOTE_TOOL_METADATA_BYTES,
  MAX_MCP_REMOTE_TOOLS_PER_PAGE,
  MAX_MCP_REMOTE_TOOLS_TOTAL,
} from '@core/application/mcp/mcp-tool-list-fetch.js';
import { MAX_MCP_TOOL_RESULT_CHARS } from '@core/application/mcp/mcp-tool-output-bounds.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
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
  clearMcpToolProxyInventoryCache();
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
  it('allows loopback HTTP MCP fetches without DNS pinning', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address() as AddressInfo;
      const lookupHostname = vi.fn(async () => {
        throw new Error('loopback MCP fetch should not resolve DNS');
      });
      const response = await createGuardedMcpFetch({
        allowLoopbackHttp: true,
        lookupHostname,
      })(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        body: '{}',
        redirect: 'error',
      });

      await expect(response.text()).resolves.toBe('{"ok":true}');
      expect(lookupHostname).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('rejects loopback pivots for remote-configured MCP transports', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '127.0.0.1', family: 4 as const },
    ]);

    await expect(
      createGuardedMcpFetch({ lookupHostname })('http://127.0.0.1:8123/mcp'),
    ).rejects.toThrow(/must be public and routable/);
    expect(lookupHostname).not.toHaveBeenCalled();
  });

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
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('allows alternate ports when they are not denylisted', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://api.github.com:8443/mcp',
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('allows an undeclared hostname when it is not denylisted', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://evil.example.com/mcp',
        denylist: [],
      }),
    ).not.toThrow();
  });

  it('lets the global denylist win over a declared host', () => {
    expect(() =>
      assertMcpNetworkHostAllowed({
        serverName: 'github',
        url: 'https://api.github.com/mcp',
        denylist: ['api.github.com'],
      }),
    ).toThrow(/matches the egress denylist/);
  });
});

describe('McpToolProxy', () => {
  it('connects same-host loopback HTTP MCP sources without remote DNS validation', async () => {
    vi.useFakeTimers();
    const lookupHostname = vi.fn(async () => {
      throw new Error('loopback MCP source should not resolve DNS');
    });
    const proxy = new McpToolProxy(
      mcpRepository({
        remote: true,
        remoteUrl: 'http://127.0.0.1:3030/mcp',
        networkHosts: ['127.0.0.1:3030'],
      }),
      {
        tools: emptyToolRepository(),
        lookupHostname,
      },
    );

    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
      }),
    ).resolves.toMatchObject({
      limit: 20,
      total: 0,
      diagnostics: {
        connectedServerCount: 1,
        deferredServerCount: 0,
        inventoryCacheHits: 0,
        inventoryCacheMisses: 1,
        liveListCalls: 1,
        liveListMs: expect.any(Number),
        discoveredToolCount: 0,
        loadedToolCount: 0,
        selectedToolCount: 0,
        returnedToolCount: 0,
      },
      servers: [
        {
          name: 'github',
          tools: [],
        },
      ],
    });
    expect(lookupHostname).not.toHaveBeenCalled();
    expect(mcpSdkMocks.StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3030/mcp'),
      expect.objectContaining({
        fetch: expect.any(Function),
      }),
    );
  });

  it('does not advertise MCP roots, sampling, or elicitation client capabilities', async () => {
    vi.useFakeTimers();
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
    });

    expect(mcpSdkMocks.Client).toHaveBeenCalledWith(
      { name: 'gantry-mcp-proxy', version: '1.0.0' },
      expect.objectContaining({
        capabilities: {},
        listChanged: expect.objectContaining({
          tools: expect.objectContaining({
            autoRefresh: false,
            onChanged: expect.any(Function),
          }),
        }),
      }),
    );
    const clientOptions = mcpSdkMocks.Client.mock.calls[0]?.[1] as {
      capabilities?: Record<string, unknown>;
      listChanged?: {
        tools?: { autoRefresh?: boolean; onChanged?: () => void };
      };
    };
    expect(clientOptions.capabilities).not.toHaveProperty('roots');
    expect(clientOptions.capabilities).not.toHaveProperty('sampling');
    expect(clientOptions.capabilities).not.toHaveProperty('elicitation');
    expect(clientOptions.listChanged?.tools?.autoRefresh).toBe(false);
  });

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
    ).resolves.toMatchObject({
      limit: 20,
      total: 2,
      diagnostics: {
        connectedServerCount: 1,
        deferredServerCount: 0,
        inventoryCacheHits: 0,
        inventoryCacheMisses: 1,
        liveListCalls: 1,
        liveListMs: expect.any(Number),
        discoveredToolCount: 2,
        loadedToolCount: 2,
        selectedToolCount: 2,
        returnedToolCount: 2,
      },
      servers: [
        {
          name: 'github',
          tools: [
            {
              name: 'create_issue',
              toolRef: 'mcp://github/tools/create_issue',
              serverName: 'github',
              sourceId: 'mcp:github',
              callable: false,
              denialReason:
                'Source inventory only; mcp_call_tool rechecks reviewed current-run action capability at call time.',
            },
            {
              name: 'search_repositories',
              toolRef: 'mcp://github/tools/search_repositories',
              serverName: 'github',
              sourceId: 'mcp:github',
              callable: false,
              denialReason:
                'Source inventory only; mcp_call_tool rechecks reviewed current-run action capability at call time.',
            },
          ],
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
    ).rejects.toThrow(/not approved for this agent/);
  });

  it('returns a bounded searchable MCP inventory page without changing call authority', async () => {
    vi.useFakeTimers();
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'search_repositories',
          description: 'Find repositories',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        },
        {
          name: 'create_issue',
          description: 'Open a GitHub issue',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
          },
        },
        { name: 'list_issues', description: 'List issues' },
      ],
    });
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    const firstPage = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      query: 'issue',
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      query: 'issue',
      limit: 1,
      total: 2,
      nextCursor: '1',
      servers: [
        {
          name: 'github',
          tools: [
            {
              name: 'create_issue',
              toolRef: 'mcp://github/tools/create_issue',
              serverName: 'github',
              sourceId: 'mcp:github',
              callable: false,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(firstPage)).not.toContain('inputSchema');

    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        query: 'issue',
        limit: 99,
        cursor: '1',
      }),
    ).resolves.toMatchObject({
      query: 'issue',
      limit: 50,
      cursor: '1',
      total: 2,
      servers: [
        {
          name: 'github',
          tools: [
            {
              name: 'list_issues',
              toolRef: 'mcp://github/tools/list_issues',
              serverName: 'github',
              sourceId: 'mcp:github',
              callable: false,
            },
          ],
        },
      ],
    });
    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(/not approved for this agent/);
  });

  it('follows remote MCP tools/list pagination for an explicit server refresh', async () => {
    vi.useFakeTimers();
    mcpSdkMocks.client.listTools
      .mockResolvedValueOnce({
        tools: [{ name: 'first_tool', description: 'page one' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'second_tool', description: 'page two' }],
      });
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    const result = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });

    expect(result).toMatchObject({
      serverName: 'github',
      total: 2,
      diagnostics: {
        liveListCalls: 1,
        remoteListPageCount: 2,
        remoteListTruncated: false,
        discoveredToolCount: 2,
        loadedToolCount: 2,
      },
      servers: [
        {
          name: 'github',
          tools: [
            { name: 'first_tool', toolRef: 'mcp://github/tools/first_tool' },
            { name: 'second_tool', toolRef: 'mcp://github/tools/second_tool' },
          ],
        },
      ],
    });
    expect(mcpSdkMocks.client.listTools).toHaveBeenNthCalledWith(
      1,
      {},
      { timeout: 60_000 },
    );
    expect(mcpSdkMocks.client.listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: 'page-2' },
      { timeout: 60_000 },
    );
  });

  it('bounds remote MCP list page size, total tools, and metadata before caching', async () => {
    const largeSchema = {
      description: 'x'.repeat(MAX_MCP_REMOTE_TOOL_METADATA_BYTES * 2),
    };
    const oversizedPage = Array.from(
      { length: MAX_MCP_REMOTE_TOOLS_PER_PAGE + 5 },
      (_, index) => ({
        name: `tool_${index}`,
        description: `tool ${index}`,
        inputSchema: largeSchema,
      }),
    );
    let page = 0;
    const client = {
      listTools: vi.fn(async () => {
        page += 1;
        return page === 1
          ? {
              tools: oversizedPage,
              nextCursor: 'page-2',
            }
          : {
              tools: Array.from(
                { length: MAX_MCP_REMOTE_TOOLS_PER_PAGE },
                (_, index) => ({ name: `page_${page}_tool_${index}` }),
              ),
              nextCursor: `page-${page + 1}`,
            };
      }),
    };

    const result = await fetchMcpToolListPages({
      client,
      timeoutMs: 1_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.tools).toHaveLength(MAX_MCP_REMOTE_TOOLS_TOTAL);
    expect(result.tools[0]).toMatchObject({
      name: 'tool_0',
      inputSchema: {
        description: expect.stringContaining('[field truncated]'),
      },
    });
    for (const tool of result.tools) {
      expect(
        Buffer.byteLength(JSON.stringify(tool), 'utf8'),
      ).toBeLessThanOrEqual(MAX_MCP_REMOTE_TOOL_METADATA_BYTES);
    }
  });

  it('describes one MCP source tool schema as untrusted metadata without granting execution', async () => {
    vi.useFakeTimers();
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          title: 'Create issue',
          description: 'Open a GitHub issue',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
          },
          outputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: 'search_repositories',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        },
      ],
    });
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    await expect(
      proxy.describeTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).resolves.toEqual({
      name: 'create_issue',
      title: 'Create issue',
      description: 'Open a GitHub issue',
      toolRef: 'mcp://github/tools/create_issue',
      serverName: 'github',
      sourceId: 'mcp:github',
      callable: false,
      denialReason:
        'Source inventory only; mcp_call_tool rechecks reviewed current-run action capability at call time.',
      metadataAuthority: 'untrusted_mcp_server',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      diagnostics: {
        detailCacheHits: 0,
        detailCacheMisses: 1,
        liveDetailCalls: 1,
        liveDetailMs: expect.any(Number),
        metadataBytes: expect.any(Number),
      },
    });
    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(/not approved for this agent/);
  });

  it('does not describe tools outside the MCP source inventory scope', async () => {
    vi.useFakeTimers();
    const proxy = new McpToolProxy(
      mcpRepository({
        remote: true,
        definitionAllowedToolPatterns: ['create_issue'],
      }),
      {
        tools: emptyToolRepository(),
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );

    await expect(
      proxy.describeTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'search_repositories',
      }),
    ).rejects.toThrow(/not available from source inventory/);
    expect(mcpSdkMocks.client.listTools).not.toHaveBeenCalled();
  });

  it('does not fan out to every uncached MCP server without an explicit serverName', async () => {
    vi.useFakeTimers();
    const proxy = new McpToolProxy(multiMcpRepository(['github', 'linear']), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        query: 'issue',
      }),
    ).resolves.toMatchObject({
      limit: 20,
      total: 0,
      deferredServers: ['github', 'linear'],
      servers: [],
    });
    expect(mcpSdkMocks.client.listTools).not.toHaveBeenCalled();

    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [{ name: 'create_issue', description: 'Open an issue' }],
    });
    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        query: 'issue',
      }),
    ).resolves.toMatchObject({
      serverName: 'github',
      query: 'issue',
      total: 1,
      servers: [{ name: 'github' }],
    });

    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        query: 'issue',
      }),
    ).resolves.toMatchObject({
      query: 'issue',
      total: 1,
      deferredServers: ['linear'],
      servers: [{ name: 'github' }],
    });
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(1);
  });

  it('reports inventory timing and invalidates the cache when source revision changes', async () => {
    vi.useFakeTimers();
    let bindingUpdatedAt = '2026-06-16T00:00:00.000Z';
    const proxy = new McpToolProxy(
      mcpRepository({
        remote: true,
        bindingUpdatedAt: () => bindingUpdatedAt,
      }),
      {
        tools: emptyToolRepository(),
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    mcpSdkMocks.client.listTools
      .mockResolvedValueOnce({
        tools: [{ name: 'first_tool', description: 'first revision' }],
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'second_tool', description: 'second revision' }],
      });

    const first = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });
    expect(first.diagnostics).toMatchObject({
      inventoryCacheHits: 0,
      inventoryCacheMisses: 1,
      liveListCalls: 1,
      discoveredToolCount: 1,
      loadedToolCount: 1,
      selectedToolCount: 1,
      returnedToolCount: 1,
    });

    const cached = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });
    expect(cached.diagnostics).toMatchObject({
      inventoryCacheHits: 1,
      inventoryCacheMisses: 0,
      liveListCalls: 0,
    });
    expect(cached.servers[0]?.tools[0]?.name).toBe('first_tool');

    bindingUpdatedAt = '2026-06-16T00:00:01.000Z';
    const refreshed = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });
    expect(refreshed.diagnostics).toMatchObject({
      inventoryCacheHits: 0,
      inventoryCacheMisses: 1,
      liveListCalls: 1,
    });
    expect(refreshed.servers[0]?.tools[0]?.name).toBe('second_tool');
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached MCP inventory when the SDK reports tools/list_changed', async () => {
    vi.useFakeTimers();
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });
    mcpSdkMocks.client.listTools
      .mockResolvedValueOnce({
        tools: [{ name: 'first_tool', description: 'before change' }],
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'second_tool', description: 'after change' }],
      });

    const first = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });
    expect(first.servers[0]?.tools[0]?.name).toBe('first_tool');

    const clientOptions = mcpSdkMocks.Client.mock.calls[0]?.[1] as {
      listChanged?: { tools?: { onChanged?: () => void } };
    };
    clientOptions.listChanged?.tools?.onChanged?.();

    const refreshed = await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });
    expect(refreshed.servers[0]?.tools[0]?.name).toBe('second_tool');
    expect(refreshed.diagnostics).toMatchObject({
      inventoryCacheHits: 0,
      inventoryCacheMisses: 1,
      liveListCalls: 1,
    });
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(2);
  });

  it('caches one-tool detail by source revision and reports detail timing', async () => {
    vi.useFakeTimers();
    let definitionUpdatedAt = '2026-06-16T00:00:00.000Z';
    const proxy = new McpToolProxy(
      mcpRepository({
        remote: true,
        definitionUpdatedAt: () => definitionUpdatedAt,
      }),
      {
        tools: emptyToolRepository(),
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    mcpSdkMocks.client.listTools
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'create_issue',
            title: 'Create issue v1',
            inputSchema: { type: 'object' },
          },
        ],
      })
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'create_issue',
            title: 'Create issue v2',
            inputSchema: { type: 'object' },
          },
        ],
      });

    const first = await proxy.describeTool({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
      toolName: 'create_issue',
    });
    expect(first.title).toBe('Create issue v1');
    expect(first.diagnostics).toMatchObject({
      detailCacheHits: 0,
      detailCacheMisses: 1,
      liveDetailCalls: 1,
      metadataBytes: expect.any(Number),
    });

    const cached = await proxy.describeTool({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
      toolName: 'create_issue',
    });
    expect(cached.title).toBe('Create issue v1');
    expect(cached.diagnostics).toMatchObject({
      detailCacheHits: 1,
      detailCacheMisses: 0,
      liveDetailCalls: 0,
      liveDetailMs: 0,
    });

    definitionUpdatedAt = '2026-06-16T00:00:01.000Z';
    const refreshed = await proxy.describeTool({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
      toolName: 'create_issue',
    });
    expect(refreshed.title).toBe('Create issue v2');
    expect(refreshed.diagnostics).toMatchObject({
      detailCacheHits: 0,
      detailCacheMisses: 1,
      liveDetailCalls: 1,
    });
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(2);
  });

  it('keeps duplicate raw MCP tool names namespaced by server identity', async () => {
    vi.useFakeTimers();
    const proxy = new McpToolProxy(multiMcpRepository(['github', 'linear']), {
      tools: emptyToolRepository(),
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });
    mcpSdkMocks.client.listTools
      .mockResolvedValueOnce({
        tools: [{ name: 'create_issue', description: 'Open a GitHub issue' }],
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'create_issue', description: 'Open a Linear issue' }],
      });

    await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
    });
    await proxy.listTools({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'linear',
    });

    await expect(
      proxy.listTools({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        query: 'create_issue',
      }),
    ).resolves.toMatchObject({
      query: 'create_issue',
      total: 2,
      servers: [
        {
          name: 'github',
          tools: [
            {
              name: 'create_issue',
              serverName: 'github',
              toolRef: 'mcp://github/tools/create_issue',
            },
          ],
        },
        {
          name: 'linear',
          tools: [
            {
              name: 'create_issue',
              serverName: 'linear',
              toolRef: 'mcp://linear/tools/create_issue',
            },
          ],
        },
      ],
    });
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
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const appendAuditEvent = vi.fn(async () => undefined);
    mockCreateIssueToolDetail();
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
        publishRuntimeEvent,
        runId: 'agent-run-1',
        runHandle: 'run-1',
      },
    );
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
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(1);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent-one',
        runId: 'agent-run-1',
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        actor: 'mcp-tool-proxy',
        responseMode: 'none',
        payload: expect.objectContaining({
          serverName: 'github',
          toolName: 'create_issue',
          requestedToolRule: 'mcp__github__create_issue',
          resultClass: 'attempt',
          argumentSummary: expect.objectContaining({
            keys: ['title'],
            keyCount: 1,
          }),
          runHandle: 'run-1',
        }),
      }),
    );
    expect(publishRuntimeEvent.mock.calls[0]?.[0].payload).not.toHaveProperty(
      'selectedCapability',
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          serverName: 'github',
          toolName: 'create_issue',
          requestedToolRule: 'mcp__github__create_issue',
          selectedToolRule: 'mcp__github__create_issue',
          selectedCapability: expect.objectContaining({
            sourceId: 'mcp:github',
            serverId: 'mcp:github',
            bindingId: 'agent-mcp-binding:github',
            sourceRevision: expect.any(String),
          }),
          resultClass: 'success',
          runHandle: 'run-1',
        }),
      }),
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain('Bug');
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tool_activity',
        actorId: 'mcp-tool-proxy',
        metadata: expect.objectContaining({
          resultClass: 'success',
          selectedToolRule: 'mcp__github__create_issue',
          selectedCapability: expect.objectContaining({
            sourceId: 'mcp:github',
            serverId: 'mcp:github',
            bindingId: 'agent-mcp-binding:github',
            sourceRevision: expect.any(String),
          }),
          argumentSummary: expect.objectContaining({
            keys: ['title'],
          }),
        }),
      }),
    );
  });

  it('does not idle-close the MCP client while a tool call is active', async () => {
    vi.useFakeTimers();
    let finishCall!: () => void;
    mockCreateIssueToolDetail();
    mcpSdkMocks.client.callTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCall = () => resolve({ content: [] });
        }),
    );
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    const pending = proxy.callTool({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
      toolName: 'create_issue',
      arguments: { title: 'Bug' },
      timeoutMs: 15 * 60_000,
    });
    await vi.waitFor(() => {
      expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(121_000);
    expect(mcpSdkMocks.client.close).not.toHaveBeenCalled();

    finishCall();
    await expect(pending).resolves.toEqual({ content: [] });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(mcpSdkMocks.client.close).toHaveBeenCalledTimes(1);
  });

  it('keeps schema discovery on the short proxy timeout for long tool calls', async () => {
    mockCreateIssueToolDetail();
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
        timeoutMs: 15 * 60_000,
      }),
    ).resolves.toEqual({ content: [] });

    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledWith(
      {},
      { timeout: 60_000 },
    );
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledWith(
      { name: 'create_issue', arguments: { title: 'Bug' } },
      undefined,
      { timeout: 15 * 60_000 },
    );
  });

  it('does not close a shared MCP client after one failed call while another call is active', async () => {
    vi.useFakeTimers();
    let failFirst!: () => void;
    let finishSecond!: () => void;
    mockCreateIssueToolDetail();
    mockCreateIssueToolDetail();
    mcpSdkMocks.client.callTool
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirst = () => reject(new Error('remote failed'));
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = () => resolve({ content: [] });
          }),
      );
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });

    const first = proxy.callTool({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
      toolName: 'create_issue',
      arguments: { title: 'One' },
      timeoutMs: 15 * 60_000,
    });
    const second = proxy.callTool({
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverName: 'github',
      toolName: 'create_issue',
      arguments: { title: 'Two' },
      timeoutMs: 15 * 60_000,
    });
    await vi.waitFor(() => {
      expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(2);
    });

    failFirst();
    await expect(first).rejects.toThrow('remote failed');
    expect(mcpSdkMocks.client.close).not.toHaveBeenCalled();

    finishSecond();
    await expect(second).resolves.toEqual({ content: [] });
    expect(mcpSdkMocks.client.close).toHaveBeenCalledTimes(1);
  });

  it('audits approved stdio MCP sources as denied until sandboxed proxy execution exists', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const appendAuditEvent = vi.fn(async () => undefined);
    const proxy = new McpToolProxy(mcpRepository({ appendAuditEvent }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      publishRuntimeEvent,
      runHandle: 'run-stdio',
    });

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      }),
    ).rejects.toThrow(/sandboxed stdio execution is implemented/);

    expect(mcpSdkMocks.Client).toHaveBeenCalledTimes(1);
    expect(mcpSdkMocks.client.connect).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        payload: expect.objectContaining({
          serverName: 'github',
          toolName: 'create_issue',
          selectedToolRule: 'mcp__github__create_issue',
          resultClass: 'denied',
          runHandle: 'run-stdio',
          error: expect.objectContaining({
            name: 'ApplicationError',
            message: expect.stringContaining('sandboxed stdio execution'),
          }),
        }),
      }),
    );
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'tool_activity',
        metadata: expect.objectContaining({
          resultClass: 'denied',
          selectedToolRule: 'mcp__github__create_issue',
          argumentSummary: expect.objectContaining({
            keys: ['title'],
          }),
        }),
      }),
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain('Bug');
  });

  it('does not turn a completed MCP side effect into a retryable failure when runtime event projection fails', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime event store unavailable'));
    mockCreateIssueToolDetail();
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
        publishRuntimeEvent,
        runId: 'agent-run-1',
        runHandle: 'run-1',
      },
    );
    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      }),
    ).resolves.toEqual({ content: [] });
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(1);
    expect(publishRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tool_activity',
        metadata: expect.objectContaining({
          resultClass: 'success',
          selectedToolRule: 'mcp__github__create_issue',
        }),
      }),
    );
  });

  it('bounds untrusted MCP tool results before returning them to IPC', async () => {
    vi.useFakeTimers();
    mockCreateIssueToolDetail();
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      isError: true,
      content: [
        { type: 'text', text: 'x'.repeat(MAX_MCP_TOOL_RESULT_CHARS + 1) },
      ],
    });

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).resolves.toMatchObject({
      type: 'mcp_tool_result_truncated',
      isError: true,
      truncated: true,
      maxChars: MAX_MCP_TOOL_RESULT_CHARS,
      preview: expect.stringContaining('[truncated MCP tool result]'),
    });
  });

  it('does not raw stringify structured MCP tool results before bounding them', async () => {
    vi.useFakeTimers();
    mockCreateIssueToolDetail();
    const proxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
    });
    const toJSON = vi.fn(() => {
      throw new Error('raw stringify should not run');
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'x'.repeat(MAX_MCP_TOOL_RESULT_CHARS + 1) },
      ],
      toJSON,
    });

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).resolves.toMatchObject({
      type: 'mcp_tool_result_truncated',
      truncated: true,
      maxChars: MAX_MCP_TOOL_RESULT_CHARS,
      preview: expect.stringContaining('[truncated MCP tool result]'),
    });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('does not turn a completed MCP side effect into a retryable failure when durable audit append fails', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit store unavailable'));
    mockCreateIssueToolDetail();
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      }),
    ).resolves.toEqual({ content: [] });
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(1);
    expect(appendAuditEvent).toHaveBeenCalledTimes(2);
  });

  it('preserves a post-return MCP validation failure when failure audit append fails', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit store unavailable'));
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: { url: { type: 'string' } },
          },
        },
      ],
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { url: 123 },
    });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    await describeCreateIssue(proxy);

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(/structuredContent failed outputSchema validation/);
    expect(appendAuditEvent).toHaveBeenCalledTimes(2);
  });

  it('audits denied and failed MCP tool calls', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const deniedProxy = new McpToolProxy(mcpRepository(), {
      tools: toolRepository(),
      publishRuntimeEvent,
    });

    await expect(
      deniedProxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'delete_repository',
      }),
    ).rejects.toThrow(/not approved/);
    expect(publishRuntimeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        payload: expect.objectContaining({
          resultClass: 'denied',
          requestedToolRule: 'mcp__github__delete_repository',
          selectedToolRule: 'mcp__github__delete_repository',
          selectedCapability: expect.objectContaining({
            sourceId: 'mcp:github',
            serverId: 'mcp:github',
            bindingId: 'agent-mcp-binding:github',
            sourceRevision: expect.any(String),
          }),
        }),
      }),
    );

    publishRuntimeEvent.mockClear();
    vi.useFakeTimers();
    mockCreateIssueToolDetail();
    mcpSdkMocks.client.callTool.mockRejectedValueOnce(
      new Error('upstream token=secret-value failure'),
    );
    const failedProxy = new McpToolProxy(mcpRepository({ remote: true }), {
      tools: emptyToolRepository(),
      liveToolRules: ['mcp__github__create_issue'],
      lookupHostname: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
      ]),
      publishRuntimeEvent,
    });

    await expect(
      failedProxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(/failure/);
    expect(publishRuntimeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        payload: expect.objectContaining({
          resultClass: 'failure',
          selectedCapability: expect.objectContaining({
            sourceId: 'mcp:github',
            serverId: 'mcp:github',
            bindingId: 'agent-mcp-binding:github',
            sourceRevision: expect.any(String),
          }),
          error: expect.objectContaining({
            message: expect.not.stringContaining('secret-value'),
          }),
        }),
      }),
    );
  });

  it('validates MCP outputSchema on a first direct call without prior describe', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    mockCreateIssueToolDetail({
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: { url: { type: 'string' } },
      },
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'secret-value' }],
    });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
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
      /declared outputSchema but returned no structuredContent/,
    );
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(1);
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(1);
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resultClass: 'failure',
          selectedToolRule: 'mcp__github__create_issue',
        }),
      }),
    );
  });

  it('validates MCP structuredContent against outputSchema before success audit', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: { url: { type: 'string' } },
          },
        },
      ],
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"url":"https://example.com/1"}' }],
      structuredContent: { url: 'https://example.com/1' },
    });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    await describeCreateIssue(proxy);

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).resolves.toMatchObject({
      structuredContent: { url: 'https://example.com/1' },
    });
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resultClass: 'success',
          outputSchemaPresent: true,
          structuredResultValidated: true,
          toolResultError: false,
        }),
      }),
    );
    expect(mcpSdkMocks.client.listTools).toHaveBeenCalledTimes(1);
  });

  it('rejects and audits invalid MCP structuredContent without logging raw values', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: { url: { type: 'string' } },
          },
        },
      ],
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'secret-value' }],
      structuredContent: { url: 123, token: 'secret-value' },
    });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
        publishRuntimeEvent,
      },
    );
    await describeCreateIssue(proxy);

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(/structuredContent failed outputSchema validation/);
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resultClass: 'failure',
          selectedToolRule: 'mcp__github__create_issue',
          error: expect.objectContaining({
            name: 'McpToolResultValidationError',
          }),
        }),
      }),
    );
    expect(JSON.stringify(appendAuditEvent.mock.calls)).not.toContain(
      'secret-value',
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
      'secret-value',
    );
  });

  it('rejects and audits missing MCP structuredContent when outputSchema is declared', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: { url: { type: 'string' } },
          },
        },
      ],
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'secret-value' }],
    });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
        publishRuntimeEvent,
      },
    );
    await describeCreateIssue(proxy);

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(
      /declared outputSchema but returned no structuredContent/,
    );
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resultClass: 'failure',
          selectedToolRule: 'mcp__github__create_issue',
          error: expect.objectContaining({
            name: 'McpToolResultValidationError',
          }),
        }),
      }),
    );
    expect(JSON.stringify(appendAuditEvent.mock.calls)).not.toContain(
      'secret-value',
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
      'secret-value',
    );
  });

  it('treats invalid MCP outputSchema metadata as unvalidated audit', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          outputSchema: 'invalid-schema',
        },
      ],
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({ content: [] });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    await describeCreateIssue(proxy);

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).resolves.toEqual({ content: [] });
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(1);
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resultClass: 'success',
          selectedToolRule: 'mcp__github__create_issue',
          outputSchemaPresent: true,
          structuredResultValidated: false,
          toolResultError: false,
        }),
      }),
    );
  });

  it('validates MCP outputSchema constraints through JSON Schema', async () => {
    vi.useFakeTimers();
    const appendAuditEvent = vi.fn(async () => undefined);
    mcpSdkMocks.client.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'create_issue',
          outputSchema: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', minLength: 1 } },
          },
        },
      ],
    });
    mcpSdkMocks.client.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"url":""}' }],
      structuredContent: { url: '' },
    });
    const proxy = new McpToolProxy(
      mcpRepository({ remote: true, appendAuditEvent }),
      {
        tools: emptyToolRepository(),
        liveToolRules: ['mcp__github__create_issue'],
        lookupHostname: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 as const },
        ]),
      },
    );
    await describeCreateIssue(proxy);

    await expect(
      proxy.callTool({
        appId: 'app-one' as never,
        agentId: 'agent-one' as never,
        serverName: 'github',
        toolName: 'create_issue',
      }),
    ).rejects.toThrow(/structuredContent failed outputSchema validation/);
    expect(mcpSdkMocks.client.callTool).toHaveBeenCalledTimes(1);
    expect(appendAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resultClass: 'failure',
          selectedToolRule: 'mcp__github__create_issue',
          error: expect.objectContaining({
            name: 'McpToolResultValidationError',
          }),
        }),
      }),
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

async function describeCreateIssue(proxy: McpToolProxy) {
  await proxy.describeTool({
    appId: 'app-one' as never,
    agentId: 'agent-one' as never,
    serverName: 'github',
    toolName: 'create_issue',
  });
}

function mockCreateIssueToolDetail(tool: Record<string, unknown> = {}) {
  mcpSdkMocks.client.listTools.mockResolvedValueOnce({
    tools: [{ name: 'create_issue', ...tool }],
  });
}

function mcpRepository(input?: {
  bindingAllowedToolPatterns?: string[];
  definitionAllowedToolPatterns?: string[];
  definitionAutoApproveToolPatterns?: string[];
  definitionUpdatedAt?: string | (() => string);
  bindingUpdatedAt?: string | (() => string);
  networkHosts?: string[];
  remote?: boolean;
  remoteUrl?: string;
  appendAuditEvent?: (event: unknown) => Promise<void>;
}) {
  const updatedAt = new Date(0).toISOString();
  const value = (entry: string | (() => string) | undefined): string =>
    typeof entry === 'function' ? entry() : (entry ?? updatedAt);
  const definition = () => ({
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
          url: input.remoteUrl ?? 'https://api.github.com/mcp',
        }
      : {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-github'],
        },
    allowedToolPatterns: input?.definitionAllowedToolPatterns ?? ['*'],
    autoApproveToolPatterns: input?.definitionAutoApproveToolPatterns ?? ['*'],
    credentialRefs: [],
    networkHosts: input?.networkHosts ?? ['api.github.com:443'],
    createdAt: updatedAt,
    updatedAt: value(input?.definitionUpdatedAt),
  });
  const binding = () => ({
    id: 'agent-mcp-binding:github',
    appId: 'app-one',
    agentId: 'agent-one',
    serverId: 'mcp:github',
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns: input?.bindingAllowedToolPatterns ?? [],
    createdAt: updatedAt,
    updatedAt: value(input?.bindingUpdatedAt),
  });
  return {
    listAgentBindings: async () => [binding()],
    getServer: async (id: string) =>
      id === 'mcp:github' ? definition() : null,
    listMaterializedServersForAgent: async () => [
      { definition: definition(), binding: binding() },
    ],
    appendAuditEvent: input?.appendAuditEvent ?? (async () => {}),
  } as never;
}

function multiMcpRepository(names: string[]) {
  const records = names.map((name) => {
    const definition = {
      id: `mcp:${name}`,
      appId: 'app-one',
      name,
      status: 'active',
      createdSource: 'admin',
      riskClass: 'medium',
      transport: 'http',
      config: {
        transport: 'http',
        url: `https://${name}.example.com/mcp`,
      },
      allowedToolPatterns: ['*'],
      autoApproveToolPatterns: ['*'],
      credentialRefs: [],
      networkHosts: [`${name}.example.com:443`],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const binding = {
      id: `agent-mcp-binding:${name}`,
      appId: 'app-one',
      agentId: 'agent-one',
      serverId: definition.id,
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    return { definition, binding };
  });
  return {
    listAgentBindings: async () => records.map((record) => record.binding),
    getServer: async (id: string) =>
      records.find((record) => record.definition.id === id)?.definition ?? null,
    listMaterializedServersForAgent: async () => records,
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
    serverId: 'mcp:github',
    bindingId: 'agent-mcp-binding:github',
    sourceRevision: JSON.stringify({
      serverId: 'mcp:github',
      serverUpdatedAt: new Date(0).toISOString(),
      bindingId: 'agent-mcp-binding:github',
      bindingUpdatedAt: new Date(0).toISOString(),
    }),
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
