import { describe, expect, it, vi } from 'vitest';

import {
  authorizedMcpServerIdsForAgent,
  mcpBindingMatchesRouteScope,
} from '@core/application/mcp/mcp-authorized-servers.js';

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

  it('does not truncate active runtime sources behind retained binding history', async () => {
    const bindings = [
      ...Array.from({ length: 500 }, (_, index) => ({
        serverId: `mcp:disabled:${index}`,
        status: 'disabled',
      })),
      { serverId: 'mcp:sum', status: 'active' },
    ];
    const listAgentBindings = vi.fn(async (input: { limit?: number } = {}) =>
      input.limit ? bindings.slice(0, input.limit) : bindings,
    );

    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: {
        listAgentBindings,
        getServer: async (id: string) =>
          id === 'mcp:sum' ? { id, appId: 'default', name: 'sum' } : null,
      } as never,
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(listAgentBindings).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:main',
    });
    expect(result).toEqual(['mcp:sum']);
  });

  it('bounds active binding lookups and database fan-out', async () => {
    const bindings = Array.from({ length: 600 }, (_, index) => ({
      serverId: `mcp:${index}`,
      status: 'active',
    }));
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const getServer = vi.fn(async (id: string) => {
      activeLookups += 1;
      maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
      await Promise.resolve();
      activeLookups -= 1;
      return { id, appId: 'default', name: id };
    });

    const result = await authorizedMcpServerIdsForAgent({
      mcpServers: {
        listAgentBindings: async () => bindings,
        getServer,
      } as never,
      appId: 'default',
      agentId: 'agent:main',
    });

    expect(result).toHaveLength(500);
    expect(getServer).toHaveBeenCalledTimes(500);
    expect(maxActiveLookups).toBeLessThanOrEqual(10);
  });

  it('fails closed for a thread-scoped binding without its parent conversation', () => {
    expect(
      mcpBindingMatchesRouteScope(
        { threadId: 'topic:42' as never },
        { conversationId: 'telegram:one', threadId: 'topic:42' },
      ),
    ).toBe(false);
    expect(
      mcpBindingMatchesRouteScope(
        {
          conversationId: 'telegram:one' as never,
          threadId: 'topic:42' as never,
        },
        { conversationId: 'telegram:one', threadId: 'topic:42' },
      ),
    ).toBe(true);
    expect(
      mcpBindingMatchesRouteScope(
        {
          conversationId: 'telegram:one' as never,
          threadId: 'topic:42' as never,
        },
        { conversationId: 'telegram:two', threadId: 'topic:42' },
      ),
    ).toBe(false);
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
