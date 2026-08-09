import { describe, expect, it, vi } from 'vitest';

import { resolveAgentToolRuntimePolicy } from '@core/application/agents/agent-tool-runtime-rules.js';

describe('resolveAgentToolRuntimePolicy', () => {
  it("merges shared with person(P) and excludes other persons' grants", async () => {
    const tools = new Map([
      ['tool:shared', { appId: 'app:test', name: 'WebSearch' }],
      ['tool:alice', { appId: 'app:test', name: 'FileRead' }],
      ['tool:bob', { appId: 'app:test', name: 'FileWrite' }],
    ]);
    const getTool = vi.fn(async (toolId: string) => tools.get(toolId) ?? null);
    const repository = {
      listAgentToolBindings: vi.fn(async () => [
        { status: 'active', toolId: 'tool:shared', personId: null },
        { status: 'active', toolId: 'tool:alice', personId: 'person:alice' },
        { status: 'active', toolId: 'tool:bob', personId: 'person:bob' },
      ]),
      getTool,
    };

    const alicePolicy = await resolveAgentToolRuntimePolicy({
      repository: repository as never,
      appId: 'app:test',
      agentId: 'agent:test',
      personId: 'person:alice',
      errorSubject: 'Configured agent tool',
    });
    const sharedPolicy = await resolveAgentToolRuntimePolicy({
      repository: repository as never,
      appId: 'app:test',
      agentId: 'agent:test',
      errorSubject: 'Configured agent tool',
    });

    expect(alicePolicy.rules).toEqual(['WebSearch', 'FileRead']);
    expect(sharedPolicy.rules).toEqual(['WebSearch']);
    expect(getTool).not.toHaveBeenCalledWith('tool:bob');
  });
});
