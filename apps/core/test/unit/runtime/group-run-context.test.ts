import { describe, expect, it } from 'vitest';

import { resolveTurnSelectedMcpServerIdsFromSnapshot } from '@core/runtime/group-run-context.js';

describe('turn MCP source selection', () => {
  it('projects a routed source only for its matching live conversation and thread', () => {
    const binding = {
      serverId: 'mcp:sum',
      status: 'active',
      conversationId: 'conversation:approved',
      threadId: 'thread:approved',
    };
    const snapshot = {
      appId: 'app:test',
      agentId: 'agent:main',
      tools: { activeBindings: [], appActiveDefinitions: [] },
      skills: { activeBindings: [], enabledDefinitions: [] },
      mcp: {
        activeBindings: [
          {
            binding,
            definition: {
              id: 'mcp:sum',
              appId: 'app:test',
              name: 'sum',
            },
          },
        ],
        materializedServers: [],
      },
    } as never;

    expect(
      resolveTurnSelectedMcpServerIdsFromSnapshot(snapshot, {
        conversationId: 'conversation:approved',
        threadId: 'thread:approved',
      }),
    ).toEqual(['mcp:sum']);
    expect(
      resolveTurnSelectedMcpServerIdsFromSnapshot(snapshot, {
        conversationId: 'conversation:other',
        threadId: 'thread:approved',
      }),
    ).toEqual([]);
    expect(
      resolveTurnSelectedMcpServerIdsFromSnapshot(snapshot, {
        conversationId: 'conversation:approved',
        threadId: 'thread:other',
      }),
    ).toEqual([]);
  });
});
