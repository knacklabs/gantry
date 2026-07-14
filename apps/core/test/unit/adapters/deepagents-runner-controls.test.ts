import { beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({
  build: vi.fn(async () => ({
    model: { profile: { maxInputTokens: 100 } },
    endpointFamily: 'openai' as const,
    modelId: 'gpt-5.5',
  })),
}));
const mcp = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  connect: vi.fn(async () => ({ tools: [], close: mcp.close })),
}));
const stream = vi.hoisted(() => ({
  normalize: vi.fn(async () => ({
    text: 'done',
    terminalResult: 'done',
    terminalUsage: undefined,
    terminalContextUsage: undefined,
  })),
}));
const deep = vi.hoisted(() => ({
  createAgent: vi.fn(() => ({ streamEvents: vi.fn(() => []) })),
}));

vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({ buildRunnerModel: model.build }),
);
vi.mock('@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js', () => ({
  connectGantryAndThirdPartyMcpTools: mcp.connect,
}));
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer.js',
  () => ({ normalizeDeepAgentStream: stream.normalize }),
);
vi.mock('deepagents', () => ({
  createDeepAgent: deep.createAgent,
  StateBackend: class {},
}));

import { runDeepAgentTurn } from '@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeepAgents worker model controls', () => {
  it('consumes worker effort, thinking, and output cap when building the model', async () => {
    await runDeepAgentTurn({
      agentInput: {
        prompt: 'hello',
        workspaceFolder: '/tmp/workspace',
        chatJid: 'conversation:test',
        effort: 'high',
        configuredThinking: { mode: 'on' },
        maxOutputTokens: 4096,
        modelCredentialEnv: {
          OPENAI_BASE_URL: 'http://127.0.0.1:4567/openai',
          OPENAI_API_KEY: 'gtw_test',
        },
      },
      provider: 'openai',
      modelId: 'gpt-5.5',
      newSessionId: 'session-1',
      includeMemoryContext: true,
      emit: vi.fn(),
    });

    expect(model.build).toHaveBeenCalledWith(
      expect.objectContaining({
        effort: 'high',
        configuredThinking: { mode: 'on' },
        maxOutputTokens: 4096,
      }),
    );
  });
});
