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
});
