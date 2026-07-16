import { describe, expect, it, vi } from 'vitest';

import { createInlineAgentLoopLaneDispatcher } from '@core/adapters/llm/inline-lane-dispatcher.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

function laneInput(engine: string) {
  return {
    group: {
      name: 'Test',
      folder: 'main_agent',
      trigger: '@test',
      added_at: new Date(0).toISOString(),
    },
    input: {
      prompt: 'hello',
      workspaceFolder: 'main_agent',
      chatJid: 'conversation:test',
      compiledSystemPrompt: 'system',
    },
    signal: new AbortController().signal,
    controlPort: { subscribe: vi.fn(() => () => undefined) },
    resolvedModel: { ok: true, value: { agentEngine: engine } },
    modelCredentialEnv: {},
    mcpServers: [],
    emitOutput: vi.fn(async () => undefined),
  } as never;
}

describe('inline lane dispatcher', () => {
  it('selects the Claude lane for the SDK engine', async () => {
    const claudeLane = vi.fn(async () => ({
      status: 'success' as const,
      result: 'claude',
    }));
    const deepAgentsLane = vi.fn();
    const coreTools = { tools: [] } as never;
    const getEgressDenylist = vi.fn(() => ['blocked.example']);
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane,
      createCoreTools: () => coreTools,
      getEgressDenylist,
    });

    await expect(dispatcher(laneInput(DEFAULT_AGENT_ENGINE))).resolves.toEqual({
      status: 'success',
      result: 'claude',
    });
    expect(claudeLane).toHaveBeenCalledWith(
      expect.objectContaining({
        coreTools,
        egressDenylist: ['blocked.example'],
      }),
    );
    expect(getEgressDenylist).toHaveBeenCalledOnce();
    expect(deepAgentsLane).not.toHaveBeenCalled();
  });

  it('selects the DeepAgents lane for the other resolved engine', async () => {
    const claudeLane = vi.fn();
    const deepAgentsLane = vi.fn(async () => ({
      status: 'success' as const,
      result: 'deep',
    }));
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane,
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(laneInput(DEEPAGENTS_ENGINE))).resolves.toEqual({
      status: 'success',
      result: 'deep',
    });
    expect(deepAgentsLane).toHaveBeenCalledOnce();
    expect(claudeLane).not.toHaveBeenCalled();
  });

  it('returns a valid structured response without another model call', async () => {
    const claudeLane = vi.fn(async () => ({
      status: 'success' as const,
      result: '{"answer":"ok"}',
    }));
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'success',
      result: '{"answer":"ok"}',
    });
    expect(claudeLane).toHaveBeenCalledOnce();
  });

  it('retries once with validation feedback and returns the corrected response', async () => {
    const claudeLane = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        result: '{"wrong":"shape"}',
        newSessionId: 'session-1',
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: '{"answer":"corrected"}',
        newSessionId: 'session-1',
      });
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const createCoreTools = vi.fn(() => ({ tools: [] }) as never);
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'success',
      result: '{"answer":"corrected"}',
    });
    expect(claudeLane).toHaveBeenCalledTimes(2);
    expect(claudeLane.mock.calls[0]?.[0].input.disableTools).toBeUndefined();
    expect(claudeLane.mock.calls[1]?.[0]).toMatchObject({
      input: {
        prompt: expect.stringMatching(/validation.*required.*answer/is),
        disableTools: true,
      },
    });
    expect(claudeLane.mock.calls[1]?.[0].input.prompt).toContain(
      '{"wrong":"shape"}',
    );
    // corrective retry must not resume the invalid attempt's provider session
    expect(claudeLane.mock.calls[1]?.[0].input.sessionId).toBeUndefined();
    expect(createCoreTools).toHaveBeenCalledOnce();
    expect(input.emitOutput).toHaveBeenCalledOnce();
    expect(input.emitOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: '{"answer":"corrected"}' }),
    );
  });

  it('bounds the failed candidate included in the repair prompt', async () => {
    const oversizedCandidate = `${'x'.repeat(5_000)}candidate-tail`;
    const claudeLane = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        result: oversizedCandidate,
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: '{"answer":"corrected"}',
      });
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await dispatcher(input);

    const repairPrompt = claudeLane.mock.calls[1]?.[0].input.prompt;
    expect(repairPrompt).toContain('x'.repeat(4_096));
    expect(repairPrompt).not.toContain('x'.repeat(4_097));
    expect(repairPrompt).not.toContain('candidate-tail');
    expect(repairPrompt).toContain('[truncated]');
  });

  it('retries a lane-marked structured-output error exactly once', async () => {
    const claudeLane = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'error',
        result: null,
        error: 'Provider structured output validation failed: answer required',
        structuredOutputValidationFailure: true,
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: '{"answer":"corrected"}',
      });
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'success',
      result: '{"answer":"corrected"}',
    });
    expect(claudeLane).toHaveBeenCalledTimes(2);
    expect(claudeLane.mock.calls[1]?.[0].input.prompt).toMatch(
      /Provider structured output validation failed: answer required/,
    );
  });

  it('keeps non-schema lane errors terminal when response_schema is present', async () => {
    const claudeLane = vi.fn(async () => ({
      status: 'error' as const,
      result: null,
      error: 'Provider authentication failed',
    }));
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'error',
      error: 'Provider authentication failed',
    });
    expect(claudeLane).toHaveBeenCalledOnce();
  });

  it('carries the last candidate when lane-marked schema retries exhaust', async () => {
    const claudeLane = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'error',
        result: '{"wrong":"first"}',
        error: 'First structured output validation failure',
        structuredOutputValidationFailure: true,
      })
      .mockResolvedValueOnce({
        status: 'error',
        result: '{"wrong":"last"}',
        error: 'Last structured output validation failure',
        structuredOutputValidationFailure: true,
      });
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'error',
      result: '{"wrong":"last"}',
      failure: { partialResult: '{"wrong":"last"}' },
    });
    expect(claudeLane).toHaveBeenCalledTimes(2);
  });

  it('returns the Tier-1 failure metadata with the last candidate after retry exhaustion', async () => {
    const claudeLane = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        result: '{"wrong":"first"}',
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: '{"wrong":"last"}',
      });
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = responseSchema();
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'error',
      result: '{"wrong":"last"}',
      error: expect.stringMatching(/failed response_schema validation/i),
      failure: {
        type: 'execution',
        attemptedAction: expect.stringMatching(/response_schema/),
        partialResult: '{"wrong":"last"}',
      },
    });
    expect(claudeLane).toHaveBeenCalledTimes(2);
    expect(input.emitOutput).toHaveBeenCalledOnce();
    expect(input.emitOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        failure: expect.objectContaining({
          partialResult: '{"wrong":"last"}',
        }),
      }),
    );
  });

  it('fails closed when an async schema validator returns a promise', async () => {
    const claudeLane = vi.fn(async () => ({
      status: 'success' as const,
      result: '{"answer":"ok"}',
    }));
    const input = laneInput(DEFAULT_AGENT_ENGINE);
    input.input.responseSchema = { $async: true, ...responseSchema() };
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane,
      deepAgentsLane: vi.fn(),
      createCoreTools: () => ({ tools: [] }) as never,
      getEgressDenylist: () => [],
    });

    await expect(dispatcher(input)).resolves.toMatchObject({
      status: 'error',
      result: '{"answer":"ok"}',
      error: expect.stringMatching(/failed response_schema validation/i),
    });
    expect(claudeLane).toHaveBeenCalledTimes(2);
  });
});

function responseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
}
