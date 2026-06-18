import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGantryTaskLifecycleStreamEvent,
  type LangGraphStreamEvent,
} from '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer.js';
import type { DeepAgentRunnerInput } from '@core/adapters/llm/deepagents-langchain/runner/types.js';

const mocks = vi.hoisted(() => ({
  buildRunnerModel: vi.fn(),
  connectTools: vi.fn(),
  createDeepAgent: vi.fn(),
  closeTools: vi.fn(),
}));

vi.mock('deepagents', () => ({
  createDeepAgent: mocks.createDeepAgent,
  StateBackend: class StateBackend {
    constructor(_config?: unknown) {}
  },
}));

vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({
    buildRunnerModel: mocks.buildRunnerModel,
  }),
);

vi.mock('@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js', () => ({
  connectGantryAndThirdPartyMcpTools: mocks.connectTools,
}));

function input(
  overrides: Partial<DeepAgentRunnerInput> = {},
): DeepAgentRunnerInput {
  return {
    prompt: 'hello from user',
    appId: 'app-one',
    agentId: 'agent-one',
    runId: 'run-one',
    workspaceFolder: 'main_agent',
    chatJid: 'tg:room-one',
    memoryContextBlock: 'secret memory text',
    allowedTools: ['send_message', 'browser_open'],
    modelCredentialEnv: {
      OPENAI_BASE_URL: 'http://127.0.0.1:4545/openai',
      OPENAI_API_KEY: 'gtw_secret_token',
    },
    ...overrides,
  };
}

async function* fakeLangGraphEvents(): AsyncIterable<LangGraphStreamEvent> {
  yield { event: 'on_chat_model_start' };
  yield { event: 'on_tool_start', name: 'send_message' };
  yield {
    event: 'on_chat_model_stream',
    data: {
      chunk: {
        content: 'hello',
        usage_metadata: {
          input_tokens: 7,
          output_tokens: 1,
        },
      },
    },
  };
  yield {
    event: 'on_chat_model_end',
    data: {
      output: {
        usage_metadata: {
          input_tokens: 7,
          output_tokens: 1,
        },
      },
    },
  };
}

async function* fakeTaskLifecycleEvents(): AsyncIterable<LangGraphStreamEvent> {
  yield buildGantryTaskLifecycleStreamEvent({
    kind: 'progress',
    taskId: 'task-1',
    toolUseId: 'toolu-1',
    summary: 'delegated work is running',
    usage: {
      totalTokens: 10,
      toolUses: 1,
      durationMs: 20,
    },
    prompt: 'raw delegated prompt must not leak',
  } as Parameters<typeof buildGantryTaskLifecycleStreamEvent>[0]);
  yield {
    event: 'on_chat_model_stream',
    data: {
      chunk: {
        content: 'done',
        usage_metadata: {
          input_tokens: 5,
          output_tokens: 1,
        },
      },
    },
  };
}

describe('runDeepAgentTurn startup diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.closeTools.mockResolvedValue(undefined);
    mocks.buildRunnerModel.mockResolvedValue({
      model: { profile: { maxInputTokens: 8192 } },
      endpointFamily: 'openai',
      modelId: 'gpt-test',
    });
    mocks.connectTools.mockResolvedValue({
      tools: [{ name: 'send_message' }],
      close: mocks.closeTools,
    });
    mocks.createDeepAgent.mockReturnValue({
      streamEvents: vi.fn(() => fakeLangGraphEvents()),
    });
  });

  it('returns sanitized startup runtime events from the real turn wiring', async () => {
    const { runDeepAgentTurn } =
      await import('@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js');
    const frames: unknown[] = [];
    const onToolStart = vi.fn();
    const toolNetworkEnv = {
      HTTP_PROXY: 'http://127.0.0.1:18790',
      HTTPS_PROXY: 'http://127.0.0.1:18790',
      NODE_USE_ENV_PROXY: '1',
    };

    const turn = await runDeepAgentTurn({
      agentInput: input({ toolNetworkEnv }),
      provider: 'openai',
      modelId: 'gpt-test',
      newSessionId: 'session-one',
      includeMemoryContext: true,
      emit: (frame) => frames.push(frame),
      onToolStart,
    });

    expect(turn.text).toBe('hello');
    expect(frames).toEqual([
      expect.objectContaining({
        status: 'success',
        result: 'hello',
        newSessionId: 'session-one',
      }),
    ]);
    expect(onToolStart).toHaveBeenCalledWith('send_message');
    expect(mocks.closeTools).toHaveBeenCalledTimes(1);
    expect(mocks.buildRunnerModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        modelId: 'gpt-test',
        gatewayBaseUrl: 'http://127.0.0.1:4545/openai',
        gatewayToken: 'gtw_secret_token',
        sessionId: 'session-one',
      }),
    );
    expect(mocks.connectTools).toHaveBeenCalledWith(
      expect.objectContaining({ toolNetworkEnv }),
    );
    const diagnostic = turn.startupRuntimeEvents?.[0];
    expect(diagnostic).toMatchObject({
      appId: 'app-one',
      agentId: 'agent-one',
      runId: 'run-one',
      conversationId: 'tg:room-one',
      eventType: 'run.startup_diagnostic',
      actor: 'runtime',
      responseMode: 'none',
      payload: {
        provider: 'deepagents',
        diagnostic: 'runner_startup',
        modelProvider: 'openai',
        modelId: 'gpt-test',
        endpointFamily: 'openai',
        selectedAllowedToolCount: 2,
        connectedToolCount: 1,
        memoryContextChars: 'secret memory text'.length,
        turnMessageCount: 2,
        cacheMode: 'none',
        checkpointerConfigured: false,
        scheduledJob: false,
        toolStartCount: 1,
        firstLangGraphEventName: 'on_chat_model_start',
      },
    });
    expect(
      (diagnostic?.payload as { firstLangGraphEventMs?: unknown })
        .firstLangGraphEventMs,
    ).toEqual(expect.any(Number));
    expect(
      (diagnostic?.payload as { firstVisibleOutputMs?: unknown })
        .firstVisibleOutputMs,
    ).toEqual(expect.any(Number));
    expect(
      (diagnostic?.payload as { toolsReadyMs?: unknown }).toolsReadyMs,
    ).toEqual(expect.any(Number));
    expect(
      (diagnostic?.payload as { firstToolStartMs?: unknown }).firstToolStartMs,
    ).toEqual(expect.any(Number));
    expect(
      (diagnostic?.payload as { phases?: Record<string, unknown> }).phases,
    ).toMatchObject({
      modelBuildMs: expect.any(Number),
      systemPromptMs: expect.any(Number),
      permissionEnvMs: expect.any(Number),
      mcpConnectMs: expect.any(Number),
      graphCreateMs: expect.any(Number),
      turnMessagesMs: expect.any(Number),
      streamIteratorMs: expect.any(Number),
      streamNormalizeMs: expect.any(Number),
    });

    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain('hello from user');
    expect(serialized).not.toContain('secret memory text');
    expect(serialized).not.toContain('http://127.0.0.1:4545/openai');
    expect(serialized).not.toContain('gtw_secret_token');
  });

  it('passes Gantry lifecycle context into DeepAgents stream normalization', async () => {
    mocks.createDeepAgent.mockReturnValue({
      streamEvents: vi.fn(() => fakeTaskLifecycleEvents()),
    });
    const { runDeepAgentTurn } =
      await import('@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js');
    const frames: Array<Record<string, unknown>> = [];

    await runDeepAgentTurn({
      agentInput: input({
        jobId: 'job-one',
        threadId: 'thread-one',
      }),
      provider: 'openai',
      modelId: 'gpt-test',
      newSessionId: 'session-one',
      includeMemoryContext: false,
      emit: (frame) => frames.push(frame as Record<string, unknown>),
    });

    const taskFrame = frames.find((frame) =>
      Array.isArray(frame.runtimeEvents),
    );
    expect(taskFrame).toMatchObject({
      status: 'success',
      result: null,
      newSessionId: 'session-one',
      runtimeEventOnly: true,
      runtimeEvents: [
        {
          appId: 'app-one',
          agentId: 'agent-one',
          runId: 'run-one',
          jobId: 'job-one',
          conversationId: 'tg:room-one',
          threadId: 'thread-one',
          actor: 'deepagents',
          eventType: 'task.progress',
          payload: {
            taskId: 'task-1',
            toolUseId: 'toolu-1',
            summary: 'delegated work is running',
            usage: {
              totalTokens: 10,
              toolUses: 1,
              durationMs: 20,
            },
          },
        },
      ],
    });
    expect(JSON.stringify(taskFrame)).not.toContain(
      'raw delegated prompt must not leak',
    );
  });

  it('passes projected DeepAgents skill sources and files through the graph state', async () => {
    const { runDeepAgentTurn } =
      await import('@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js');
    const skillProjection = {
      sources: ['/skills/'],
      selectedSkillIds: ['skill:release'],
      skillCount: 1,
      fileCount: 1,
      contentBytes: 112,
      files: {
        '/skills/release-writer/SKILL.md': {
          content: `---
name: release-writer
description: Use this skill for release notes.
---
`,
          mimeType: 'text/markdown',
          created_at: '2026-06-16T00:00:00.000Z',
          modified_at: '2026-06-16T00:00:00.000Z',
        },
      },
    };

    const turn = await runDeepAgentTurn({
      agentInput: input({ deepAgentSkills: skillProjection }),
      provider: 'openai',
      modelId: 'gpt-test',
      newSessionId: 'session-one',
      includeMemoryContext: true,
      emit: () => {},
    });

    expect(mocks.createDeepAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: ['/skills/'],
        permissions: [
          { operations: ['read'], paths: ['/skills', '/skills/**'] },
          { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
        ],
      }),
    );
    const graph = mocks.createDeepAgent.mock.results[0]?.value as {
      streamEvents: ReturnType<typeof vi.fn>;
    };
    expect(graph.streamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        files: skillProjection.files,
      }),
      expect.any(Object),
    );
    expect(turn.startupRuntimeEvents?.[0]?.payload).toMatchObject({
      deepAgentSkillSourceCount: 1,
      deepAgentSkillFileCount: 1,
      deepAgentSkillContentBytes: 112,
      deepAgentSkillReadToolsEnabled: true,
    });
  });

  it('tombstones checkpointed skill files when no skills are selected', async () => {
    const { runDeepAgentTurn } =
      await import('@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js');
    const previousFile = {
      content: 'old skill',
      mimeType: 'text/markdown',
      created_at: '2026-06-16T00:00:00.000Z',
      modified_at: '2026-06-16T00:00:00.000Z',
    };
    const checkpointer = {
      getTuple: vi.fn(async () => ({
        checkpoint: {
          channel_values: {
            files: {
              '/skills/old/SKILL.md': previousFile,
              '/scratch.txt': previousFile,
            },
          },
        },
      })),
    };

    await runDeepAgentTurn({
      agentInput: input(),
      provider: 'openai',
      modelId: 'gpt-test',
      newSessionId: 'session-one',
      threadId: 'session-one',
      checkpointer: checkpointer as never,
      includeMemoryContext: false,
      emit: () => {},
    });

    const graph = mocks.createDeepAgent.mock.results[0]?.value as {
      streamEvents: ReturnType<typeof vi.fn>;
    };
    expect(graph.streamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        files: {
          '/skills/old/SKILL.md': null,
        },
      }),
      expect.any(Object),
    );
    expect(
      (graph.streamEvents.mock.calls[0]?.[0] as { files?: object }).files,
    ).not.toHaveProperty('/scratch.txt');
  });
});
