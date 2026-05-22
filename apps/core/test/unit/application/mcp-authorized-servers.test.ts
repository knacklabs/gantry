import { describe, expect, it } from 'vitest';

import { authorizedMcpServerIdsForAgent } from '@core/application/mcp/mcp-authorized-servers.js';

describe('authorizedMcpServerIdsForAgent', () => {
  it('does not authorize attached MCP sources without projected capability rules', async () => {
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository(),
      tools: toolRepository(),
      appId: 'default',
      agentId: 'agent:main',
      allowedTools: [],
    });

    expect(result).toEqual([]);
  });

  it('authorizes only attached MCP servers referenced by selected capability rules', async () => {
    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: mcpServerRepository(),
      tools: toolRepository(),
      appId: 'default',
      agentId: 'agent:main',
      allowedTools: ['mcp__github__create_issue'],
    });

    expect(result).toEqual(['mcp:github']);
  });
});

function mcpServerRepository() {
  const bindings = [
    {
      serverId: 'mcp:github',
      status: 'active',
    },
    {
      serverId: 'mcp:slack',
      status: 'active',
    },
  ];
  const servers = new Map([
    ['mcp:github', { id: 'mcp:github', appId: 'default', name: 'github' }],
    ['mcp:slack', { id: 'mcp:slack', appId: 'default', name: 'slack' }],
  ]);
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
