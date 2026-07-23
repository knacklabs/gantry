import { describe, expect, it } from 'vitest';

import { resolveTurnSelectedMcpServerIds } from '@core/runtime/group-run-context.js';

describe('turn MCP source selection', () => {
  it('projects a routed source only for its matching live conversation and thread', async () => {
    const binding = {
      serverId: 'mcp:sum',
      status: 'active',
      conversationId: 'conversation:approved',
      threadId: 'thread:approved',
    };
    const deps = {
      getMcpServerRepository: () => ({
        listAgentBindings: async () => [binding],
        getServer: async () => ({
          id: 'mcp:sum',
          appId: 'app:test',
          name: 'sum',
        }),
      }),
    } as never;
    const turn = { appId: 'app:test', agentId: 'agent:main' };

    await expect(
      resolveTurnSelectedMcpServerIds(deps, turn, {
        conversationId: 'conversation:approved',
        threadId: 'thread:approved',
      }),
    ).resolves.toEqual(['mcp:sum']);
    await expect(
      resolveTurnSelectedMcpServerIds(deps, turn, {
        conversationId: 'conversation:other',
        threadId: 'thread:approved',
      }),
    ).resolves.toEqual([]);
    await expect(
      resolveTurnSelectedMcpServerIds(deps, turn, {
        conversationId: 'conversation:approved',
        threadId: 'thread:other',
      }),
    ).resolves.toEqual([]);
  });
});
