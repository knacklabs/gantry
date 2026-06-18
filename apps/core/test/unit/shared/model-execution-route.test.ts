import { describe, expect, it } from 'vitest';

import { resolveModelSelection } from '@core/shared/model-catalog.js';
import {
  deriveAgentEngineForProvider,
  engineForExecutionProviderId,
  executionRoutesForEntry,
  resolveExecutionRoute,
} from '@core/shared/model-execution-route.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

function entryFor(alias: string) {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(`fixture alias ${alias} did not resolve`);
  return resolved.entry;
}

function route(alias: string) {
  return resolveExecutionRoute({ entry: entryFor(alias) });
}

describe('provider-derived execution route', () => {
  it('anthropic provider -> anthropic SDK adapter (both credential modes)', () => {
    expect(route('opus')).toMatchObject({
      ok: true,
      value: {
        engine: DEFAULT_AGENT_ENGINE,
        executionProviderId: 'anthropic:claude-agent-sdk',
        supportedCredentialModes: ['api_key', 'claude_code_oauth'],
      },
    });
  });

  it('openrouter route -> deepagents langchain adapter, api_key only', () => {
    expect(route('kimi')).toMatchObject({
      ok: true,
      value: {
        engine: DEEPAGENTS_ENGINE,
        executionProviderId: 'deepagents:langchain',
        supportedCredentialModes: ['api_key'],
      },
    });
  });

  it('openai provider -> deepagents langchain adapter, api_key only', () => {
    expect(route('gpt')).toMatchObject({
      ok: true,
      value: {
        engine: DEEPAGENTS_ENGINE,
        executionProviderId: 'deepagents:langchain',
        supportedCredentialModes: ['api_key'],
      },
    });
  });

  it('derives the engine from a provider id', () => {
    expect(deriveAgentEngineForProvider('anthropic')).toBe(
      DEFAULT_AGENT_ENGINE,
    );
    expect(deriveAgentEngineForProvider('openrouter')).toBe(DEEPAGENTS_ENGINE);
    expect(deriveAgentEngineForProvider('openai')).toBe(DEEPAGENTS_ENGINE);
    // Unknown provider falls back to the system default engine.
    expect(deriveAgentEngineForProvider('nope')).toBe(DEFAULT_AGENT_ENGINE);
  });

  it('surfaces the derived route as a one-element diagnostic array', () => {
    expect(executionRoutesForEntry(entryFor('opus'))).toEqual([
      {
        harness: DEFAULT_AGENT_ENGINE,
        executionProviderId: 'anthropic:claude-agent-sdk',
      },
    ]);
    expect(executionRoutesForEntry(entryFor('kimi'))).toEqual([
      {
        harness: DEEPAGENTS_ENGINE,
        executionProviderId: 'deepagents:langchain',
      },
    ]);
  });

  it('reverse-maps an executionProviderId back to its agent engine (run diagnostics)', () => {
    expect(engineForExecutionProviderId('anthropic:claude-agent-sdk')).toBe(
      DEFAULT_AGENT_ENGINE,
    );
    expect(engineForExecutionProviderId('deepagents:langchain')).toBe(
      DEEPAGENTS_ENGINE,
    );
    expect(engineForExecutionProviderId('unknown:provider')).toBeUndefined();
  });
});
