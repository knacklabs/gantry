import { describe, expect, it, vi } from 'vitest';

const deep = vi.hoisted(() => ({ createAgent: vi.fn() }));
const model = vi.hoisted(() => ({ build: vi.fn() }));
const normalizer = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('deepagents', () => ({
  createDeepAgent: deep.createAgent,
  createAgentMemoryMiddleware: () => ({ name: 'memory' }),
  StateBackend: class {},
}));
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({ buildRunnerModel: model.build }),
);
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    normalizeDeepAgentStream: normalizer.run,
  }),
);

import { createDeepAgentsInlineAgentLoopLane } from '@core/adapters/llm/deepagents-langchain/inline-lane/index.js';
import { DeepAgentPartialUsage } from '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer-partial-usage.js';

describe('deepagents inline lane', () => {
  it('an errored turn emits one terminal error output carrying accumulated usage', async () => {
    const usage = {
      model: 'gpt-5.5',
      provider: 'openai' as const,
      modelRoute: 'openai' as const,
      inputTokens: 1000,
      outputTokens: 12,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 200,
      cacheProvider: 'openai' as const,
      cacheStatus: 'hit' as const,
      at: '2026-09-09T00:00:00.000Z',
    };
    const contextUsage = {
      totalTokens: 1012,
      maxTokens: 400_000,
      percentage: 0.253,
      categories: [],
      at: '2026-09-09T00:00:00.000Z',
    };

    const partial = new DeepAgentPartialUsage(
      new Error('gateway failed'),
      usage,
      contextUsage,
      'inline-session:run:1',
    );
    const emitOutput = vi.fn(async () => undefined);
    deep.createAgent.mockReturnValue({ streamEvents: vi.fn() });
    model.build.mockResolvedValue({
      model: { profile: { maxInputTokens: 400_000 } },
      endpointFamily: 'openai',
      modelId: 'gpt-5.5',
    });
    normalizer.run.mockRejectedValueOnce(partial);

    const lane = createDeepAgentsInlineAgentLoopLane({
      databaseUrl: null,
      schema: 'gantry',
    });
    const output = await lane({
      input: {
        prompt: 'run once',
        workspaceFolder: 'main_agent',
        chatJid: 'conversation:test',
        compiledSystemPrompt: 'system prompt',
        isScheduledJob: true,
        disableTools: true,
      },
      signal: new AbortController().signal,
      controlPort: { subscribe: () => () => undefined },
      resolvedModel: {
        ok: true,
        value: {
          runnerModel: 'gpt-5.5',
          modelEntry: { modelRoute: { id: 'openai' } },
        },
      },
      modelCredentialEnv: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9999/openai',
        OPENAI_API_KEY: 'gtw_test',
      },
      mcpServers: [],
      egressDenylist: [],
      coreTools: { tools: [] },
      emitOutput,
    } as never);

    expect(output).toEqual({
      status: 'error',
      result: null,
      error: 'gateway failed',
      newSessionId: expect.any(String),
      usage,
      usageEventId: 'inline-session:run:1',
      contextUsage,
    });
    expect(emitOutput).toHaveBeenCalledTimes(1);
    expect(emitOutput).toHaveBeenCalledWith(output);
  });
});
