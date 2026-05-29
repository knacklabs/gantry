import { describe, expect, it } from 'vitest';

import { authorizedMcpServerIdsForAgent } from '@core/application/mcp/mcp-authorized-servers.js';

describe('authorizedMcpServerIdsForAgent', () => {
  it('authorizes every actively-bound in-app MCP server (the binding is the grant)', async () => {
    // A binding is created only via approved flows (an operator-declared
    // sources.mcp_servers entry reconciled from authoritative settings, or an
    // approved request_mcp_server), so the binding itself authorizes the server
    // — no separate per-tool capability rule is required. allowedTools is empty
    // here on purpose.
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository(),
      tools: toolRepository(),
      appId: 'default',
      agentId: 'agent:main',
      allowedTools: [],
    });

    expect([...result].sort()).toEqual(['mcp:github', 'mcp:slack']);
  });

  it('excludes inactive bindings and servers from another app', async () => {
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository({
        bindings: [
          { serverId: 'mcp:github', status: 'active' },
          { serverId: 'mcp:slack', status: 'revoked' },
          { serverId: 'mcp:other', status: 'active' },
        ],
        servers: [
          ['mcp:github', { id: 'mcp:github', appId: 'default', name: 'github' }],
          ['mcp:slack', { id: 'mcp:slack', appId: 'default', name: 'slack' }],
          ['mcp:other', { id: 'mcp:other', appId: 'other-app', name: 'other' }],
        ],
      }),
      tools: toolRepository(),
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(result).toEqual(['mcp:github']);
  });

  it('returns [] when the agent has no active bindings', async () => {
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository({ bindings: [], servers: [] }),
      tools: toolRepository(),
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(result).toEqual([]);
  });
});

function mcpServerRepository(opts?: {
  bindings?: Array<{ serverId: string; status: string }>;
  servers?: Array<[string, { id: string; appId: string; name: string }]>;
}) {
  const bindings = opts?.bindings ?? [
    { serverId: 'mcp:github', status: 'active' },
    { serverId: 'mcp:slack', status: 'active' },
  ];
  const servers = new Map(
    opts?.servers ?? [
      ['mcp:github', { id: 'mcp:github', appId: 'default', name: 'github' }],
      ['mcp:slack', { id: 'mcp:slack', appId: 'default', name: 'slack' }],
    ],
  );
  return {
    listAgentBindings: async () => bindings,
    getServer: async (id: string) => servers.get(id) ?? null,
  } as never;
}

function toolRepository() {
  return {
    listAgentToolBindings: async () => [],
  } as never;
}
