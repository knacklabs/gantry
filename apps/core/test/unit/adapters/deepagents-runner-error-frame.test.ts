import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeepAgentPartialUsage } from '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer-partial-usage.js';

const runner = vi.hoisted(() => ({ turn: vi.fn() }));
const frames = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js',
  () => ({ runDeepAgentTurn: runner.turn }),
);
vi.mock('@core/runner/runner-frame.js', () => ({
  readRunnerStdin: frames.read,
  writeRunnerFrame: frames.write,
}));
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/job-heartbeat.js',
  () => ({
    startDeepAgentJobHeartbeat: () => ({
      markActivity: () => undefined,
      recordToolActivity: () => undefined,
      stop: () => undefined,
    }),
  }),
);
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/session-store.js',
  () => ({
    DeepAgentSessionStore: { newSessionId: () => 'runner-session' },
    createDeepAgentCheckpointTiming: vi.fn(),
  }),
);

describe('deepagents runner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('GANTRY_DEEPAGENTS_MODEL_ID', 'gpt-5.5');
    vi.stubEnv('GANTRY_DEEPAGENTS_MODEL_PROVIDER', 'openai');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes the partial usage on the single error frame', async () => {
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
    runner.turn.mockRejectedValueOnce(
      new DeepAgentPartialUsage(
        new Error('gateway failed'),
        usage,
        contextUsage,
        'runner-session:run:1',
      ),
    );
    frames.read.mockResolvedValueOnce(
      JSON.stringify({
        prompt: 'run once',
        workspaceFolder: 'main_agent',
        chatJid: 'conversation:test',
        isScheduledJob: true,
      }),
    );

    await import('@core/adapters/llm/deepagents-langchain/runner/index.js');

    await vi.waitFor(() =>
      expect(frames.write).toHaveBeenCalledWith({
        status: 'error',
        result: null,
        newSessionId: 'runner-session',
        error: 'gateway failed',
        usage,
        usageEventId: 'runner-session:run:1',
        contextUsage,
      }),
    );
    expect(frames.write).toHaveBeenCalledTimes(1);
  });
});
