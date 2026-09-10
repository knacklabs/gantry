import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  createServer: vi.fn(),
  createTool: vi.fn(),
  query: vi.fn(),
}));
const remoteMcp = vi.hoisted(() => ({
  create: vi.fn(async () => ({ servers: [], close: async () => undefined })),
}));
const claudeSdkPackage = vi.hoisted(() =>
  ['@anthropic-ai', 'claude-agent-sdk'].join('/'),
);

vi.mock(claudeSdkPackage, () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'dynamic-boundary',
  createSdkMcpServer: sdk.createServer,
  query: sdk.query,
  tool: sdk.createTool,
}));
vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/inline-lane/remote-mcp-proxy.js',
  () => ({ createPinnedClaudeMcpProxies: remoteMcp.create }),
);

import { runClaudeInlineAgentLoopLane } from '@core/adapters/llm/anthropic-claude-agent/inline-lane/index.js';
import { InMemoryInlineRunnerControlPort } from '@core/runtime/agent-inline.js';

function laneInput() {
  const emitOutput = vi.fn(async () => undefined);
  const apiKeyEnv = ['ANTHROPIC', 'API_KEY'].join('_');
  const baseUrlEnv = ['ANTHROPIC', 'BASE_URL'].join('_');
  return {
    group: { folder: 'main_agent' },
    input: {
      chatJid: 'conversation:test',
      compiledSystemPrompt: 'system prompt',
      prompt: 'first prompt',
      workspaceFolder: 'main_agent',
    },
    signal: new AbortController().signal,
    controlPort: new InMemoryInlineRunnerControlPort(),
    resolvedModel: {
      ok: true,
      value: {
        runnerModel: 'claude-sonnet-4-6',
        modelEntry: {
          displayName: 'Claude Sonnet',
          modelRoute: { id: 'anthropic' },
        },
      },
    },
    modelCredentialEnv: {
      [apiKeyEnv]: 'gtw_test',
      [baseUrlEnv]: 'http://127.0.0.1:9999',
    },
    mcpServers: [],
    egressDenylist: [],
    runtimeDataDir: '/tmp/gantry-inline-test',
    emitOutput,
    coreTools: {
      tools: [],
      execute: vi.fn(),
      authorizeThirdPartyMcpTool: vi.fn(),
      recordThirdPartyMcpToolActivity: vi.fn(),
    },
  } as never;
}

describe('claude inline lane', () => {
  it('an errored turn emits one terminal error output carrying accumulated usage', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['Provider unavailable.'],
          request_id: 'usage-event-1',
          modelUsage: {
            'claude-sonnet-4-6': {
              inputTokens: 1_000,
              outputTokens: 12,
              cacheReadInputTokens: 270_000,
              cacheCreationInputTokens: 500,
            },
          },
        };
      },
    }));
    const input = laneInput();

    const result = await runClaudeInlineAgentLoopLane(input);

    expect(result).toMatchObject({
      status: 'error',
      error: 'Provider unavailable.',
      usageEventId: 'usage-event-1',
      usage: {
        inputTokens: 1_000,
        outputTokens: 12,
        cacheReadTokens: 270_000,
        cacheWriteTokens: 500,
      },
    });
    expect(input.emitOutput).toHaveBeenCalledTimes(1);
    expect(input.emitOutput).toHaveBeenCalledWith(result);
  });
});
