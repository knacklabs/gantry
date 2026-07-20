import { describe, expect, it } from 'vitest';

import { authorizedMcpServerIdsForAgent } from '@core/application/mcp/mcp-authorized-servers.js';

describe('authorizedMcpServerIdsForAgent', () => {
  it('projects every active attached MCP source', async () => {
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository(),
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(result).toEqual(['mcp:github', 'mcp:slack']);
  });

  it('keeps inventory-only bound servers projected alongside rule-matched servers', async () => {
    // Regression (trace defect 1): a freshly connected inventory-only server
    // (slack) must not be dropped from next-turn projection just because
    // another server (github) has a selected mcp__ tool rule. Discovery is not
    // authorization; action stays capability-gated at call time.
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository(),
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(result).toContain('mcp:slack');
    expect(result).toContain('mcp:github');
  });

  it('skips disabled bindings and servers from other apps', async () => {
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository({
        extraBindings: [
          { serverId: 'mcp:disabled', status: 'disabled' },
          { serverId: 'mcp:other-app', status: 'active' },
        ],
        extraServers: [
          [
            'mcp:disabled',
            { id: 'mcp:disabled', appId: 'default', name: 'disabled' },
          ],
          [
            'mcp:other-app',
            { id: 'mcp:other-app', appId: 'other', name: 'other' },
          ],
        ],
      }),
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(result).toEqual(['mcp:github', 'mcp:slack']);
  });
});

function mcpServerRepository(input?: {
  extraBindings?: Array<{ serverId: string; status: string }>;
  extraServers?: Array<[string, { id: string; appId: string; name: string }]>;
}) {
  const bindings = [
    {
      serverId: 'mcp:github',
      status: 'active',
    },
    {
      serverId: 'mcp:slack',
      status: 'active',
    },
    ...(input?.extraBindings ?? []),
  ];
  const servers = new Map([
    ['mcp:github', { id: 'mcp:github', appId: 'default', name: 'github' }],
    ['mcp:slack', { id: 'mcp:slack', appId: 'default', name: 'slack' }],
    ...(input?.extraServers ?? []),
  ]);
  return {
    listAgentBindings: async () => bindings,
    getServer: async (id: string) => servers.get(id) ?? null,
  } as never;
}
