import { describe, expect, it } from 'vitest';

import {
  createAgentExecutionAdapterRegistry,
  resolveAgentExecutionAdapter,
} from '@core/application/agent-execution/agent-execution-adapter-registry.js';
import type { AgentExecutionAdapter } from '@core/application/agent-execution/agent-execution-adapter.js';

function fakeAdapter(id: string): AgentExecutionAdapter {
  return {
    id: id as AgentExecutionAdapter['id'],
    prepare: (async () => {
      throw new Error('not used');
    }) as AgentExecutionAdapter['prepare'],
  } as AgentExecutionAdapter;
}

describe('agent execution adapter registry (A9 rejection coverage)', () => {
  it('rejects a duplicate adapter id', () => {
    expect(() =>
      createAgentExecutionAdapterRegistry([
        fakeAdapter('deepagents:langchain'),
        fakeAdapter('deepagents:langchain'),
      ]),
    ).toThrow('Duplicate agent execution adapter id: deepagents:langchain');
  });

  it('rejects an adapter with an empty id', () => {
    expect(() =>
      createAgentExecutionAdapterRegistry([
        fakeAdapter('  ') as AgentExecutionAdapter,
      ]),
    ).toThrow('Agent execution adapter id is required.');
  });

  it('throws on an unknown execution provider id with no fallback', () => {
    const registry = createAgentExecutionAdapterRegistry([
      fakeAdapter('anthropic:claude-agent'),
    ]);
    expect(() =>
      resolveAgentExecutionAdapter({
        executionProviderId: 'mystery:provider',
        registry,
      }),
    ).toThrow('Unsupported model execution provider: mystery:provider');
  });

  it('throws on an unknown execution provider id even when a non-matching fallback exists', () => {
    const registry = createAgentExecutionAdapterRegistry([]);
    expect(() =>
      resolveAgentExecutionAdapter({
        executionProviderId: 'mystery:provider',
        registry,
        fallback: fakeAdapter('anthropic:claude-agent'),
      }),
    ).toThrow('Unsupported model execution provider: mystery:provider');
  });

  it('returns undefined from an empty registry when no id and no fallback are given', () => {
    const registry = createAgentExecutionAdapterRegistry([]);
    expect(resolveAgentExecutionAdapter({ registry })).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('resolves a registered adapter and a matching fallback by id', () => {
    const registered = fakeAdapter('deepagents:langchain');
    const registry = createAgentExecutionAdapterRegistry([registered]);
    expect(
      resolveAgentExecutionAdapter({
        executionProviderId: 'deepagents:langchain',
        registry,
      }),
    ).toBe(registered);

    const fallback = fakeAdapter('anthropic:claude-agent');
    expect(
      resolveAgentExecutionAdapter({
        executionProviderId: 'anthropic:claude-agent',
        registry: createAgentExecutionAdapterRegistry([]),
        fallback,
      }),
    ).toBe(fallback);
  });
});
