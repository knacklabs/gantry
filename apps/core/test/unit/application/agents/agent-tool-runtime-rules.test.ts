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

  it('drops a stale RunCommand grant a stricter validator rejects without losing the agent\'s other grants', async () => {
    // Regression: a stored `RunCommand(npx remotion *)` grant (valid when
    // minted, rejected after the npx family hardening) must not throw and take
    // down every other durable grant for the agent.
    const tools = new Map<string, { appId: string; name: string }>([
      ['tool:curl', { appId: 'app:test', name: 'RunCommand(curl *)' }],
      ['tool:npx', { appId: 'app:test', name: 'RunCommand(npx remotion *)' }],
      ['tool:web', { appId: 'app:test', name: 'WebSearch' }],
    ]);
    const getTool = vi.fn(async (toolId: string) => tools.get(toolId) ?? null);
    const repository = {
      listAgentToolBindings: vi.fn(async () => [
        { status: 'active', toolId: 'tool:curl', personId: null },
        { status: 'active', toolId: 'tool:npx', personId: null },
        { status: 'active', toolId: 'tool:web', personId: null },
      ]),
      getTool,
    };

    const policy = await resolveAgentToolRuntimePolicy({
      repository: repository as never,
      appId: 'app:test',
      agentId: 'agent:test',
      errorSubject: 'Configured agent tool',
    });

    // Valid grants survive; the invalid npx family grant is dropped (so npx
    // re-asks) rather than throwing and nuking the whole policy.
    expect(policy.rules).toEqual(['RunCommand(curl *)', 'WebSearch']);
  });
});
