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
import {
  evaluateDeclarativeToolRules,
  RunScopedToolSuccessLedger,
} from '@core/runner/tool-gate-core.js';

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
    expect(mcp.connect.mock.calls[0]?.[0]).not.toHaveProperty('toolRules');
    expect(mcp.connect.mock.calls[0]?.[0]).not.toHaveProperty(
      'toolSuccessLedger',
    );
    expect(mcp.connect.mock.calls[0]?.[0]).not.toHaveProperty(
      'onToolRuleDenial',
    );
  });

  it('threads declarative rules and emits the existing tool-activity denial event', async () => {
    const emit = vi.fn();
    const toolRules = [
      { tool: 'send_message', action: 'block' as const, reason: 'quiet run' },
    ];
    await runDeepAgentTurn({
      agentInput: {
        prompt: 'hello',
        workspaceFolder: '/tmp/workspace',
        chatJid: 'conversation:test',
        appId: 'default',
        agentId: 'agent-1',
        runId: 'run-1',
        jobId: 'job-1',
        isScheduledJob: true,
        toolRules,
        modelCredentialEnv: {
          OPENAI_BASE_URL: 'http://127.0.0.1:4567/openai',
          OPENAI_API_KEY: 'gtw_test',
        },
      },
      provider: 'openai',
      modelId: 'gpt-5.5',
      newSessionId: 'session-1',
      includeMemoryContext: true,
      emit,
    });

    const gate = mcp.connect.mock.calls[0]?.[0];
    expect(gate).toMatchObject({ toolRules });
    gate?.onToolRuleDenial?.('send_message', {
      decision: 'declarative_tool_rule',
      reason: 'Denied by Gantry tool rule: quiet run',
      error: {
        category: 'permission',
        isRetryable: false,
        message: 'Denied by Gantry tool rule: quiet run',
      },
    });
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            eventType: 'job.tool_activity',
            payload: expect.objectContaining({
              phase: 'deny',
              reason: 'Denied by Gantry tool rule: quiet run',
            }),
          }),
        ],
      }),
    );
  });

  it('keeps require_prior success through a continuation but not a new run', async () => {
    const toolRules = [
      {
        tool: 'deploy',
        action: 'require_prior' as const,
        prior: 'test',
        reason: 'test before deploy',
      },
    ];
    const firstInput = {
      prompt: 'test then deploy',
      workspaceFolder: '/tmp/workspace',
      chatJid: 'conversation:test',
      toolRules,
      modelCredentialEnv: {
        OPENAI_BASE_URL: 'http://127.0.0.1:4567/openai',
        OPENAI_API_KEY: 'gtw_test',
      },
    };
    const runLedger = new RunScopedToolSuccessLedger();
    const runTurn = (agentInput: typeof firstInput, ledger = runLedger) =>
      runDeepAgentTurn({
        agentInput,
        provider: 'openai',
        modelId: 'gpt-5.5',
        newSessionId: 'session-1',
        includeMemoryContext: false,
        toolSuccessLedger: ledger,
        emit: vi.fn(),
      });

    await runTurn(firstInput);
    const firstTurnLedger = mcp.connect.mock.calls[0]?.[0].toolSuccessLedger;
    expect(firstTurnLedger).toBe(runLedger);
    firstTurnLedger?.recordSuccess('test');

    await runTurn({ ...firstInput, prompt: 'follow up: deploy' });
    expect(mcp.connect.mock.calls[1]?.[0].toolSuccessLedger).toBe(runLedger);
    expect(
      evaluateDeclarativeToolRules({
        toolName: 'deploy',
        toolInput: {},
        rules: toolRules,
        successLedger: mcp.connect.mock.calls[1]?.[0].toolSuccessLedger,
      }),
    ).toBeNull();

    await runTurn(
      { ...firstInput, prompt: 'new run: deploy' },
      new RunScopedToolSuccessLedger(),
    );
    expect(mcp.connect.mock.calls[2]?.[0].toolSuccessLedger).not.toBe(
      runLedger,
    );
    expect(
      evaluateDeclarativeToolRules({
        toolName: 'deploy',
        toolInput: {},
        rules: toolRules,
        successLedger: mcp.connect.mock.calls[2]?.[0].toolSuccessLedger,
      }),
    ).toMatchObject({ decision: 'declarative_tool_rule' });
  });
});
