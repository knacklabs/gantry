import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const harness = vi.hoisted(() => {
  const close = vi.fn(async () => undefined);
  return {
    close,
    connect: vi.fn(),
    model: undefined as unknown,
    tools: [] as unknown[],
  };
});

vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({
    buildRunnerModel: vi.fn(async () => ({
      model: harness.model,
      endpointFamily: 'openai' as const,
      modelId: 'gpt-5.5',
    })),
  }),
);

vi.mock('@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js', () => ({
  connectGantryAndThirdPartyMcpTools: harness.connect,
}));

import { runDeepAgentTurn } from '@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
  harness.tools = [];
});

describe('DeepAgents terminal permission denial', () => {
  it('a denied tool cancels a concurrent side-effecting sibling tool in the same turn', async () => {
    const [{ fakeModel }, { AIMessage }, { tool }] = await Promise.all([
      import('@langchain' + '/core/testing'),
      import('@langchain' + '/core/messages'),
      import('@langchain' + '/core/tools'),
    ]);
    const model = fakeModel()
      .respondWithTools([
        { name: 'denied_tool', args: {} },
        { name: 'fallback_tool', args: {} },
      ])
      .respond(new AIMessage('silently continued'));
    harness.model = model;

    let gate:
      | {
          onPermissionDenied?: (input: {
            toolName: string;
            reason: string;
          }) => never;
          signal?: AbortSignal;
        }
      | undefined;
    let releaseSibling!: () => void;
    const denialReached = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let fallbackCalls = 0;
    harness.tools = [
      tool(
        async () => {
          releaseSibling();
          return gate?.onPermissionDenied?.({
            toolName: 'denied_tool',
            reason: 'Unattended jobs do not wait for approval.',
          });
        },
        {
          name: 'denied_tool',
          description: 'Always denied during this autonomous turn.',
          schema: z.object({}),
        },
      ),
      tool(
        async () => {
          await denialReached;
          gate?.signal?.throwIfAborted();
          fallbackCalls += 1;
          return 'fallback ran';
        },
        {
          name: 'fallback_tool',
          description: 'Would prove silent continuation if invoked.',
          schema: z.object({}),
        },
      ),
    ];
    harness.connect.mockImplementationOnce(async (input) => {
      gate = input.gate;
      return { tools: harness.tools, close: harness.close };
    });
    const emit = vi.fn();

    await expect(
      runDeepAgentTurn({
        agentInput: {
          prompt: 'Use denied_tool, then fall back to fallback_tool.',
          workspaceFolder: '/tmp/workspace',
          chatJid: 'conversation:test',
          appId: 'default',
          agentId: 'agent-1',
          runId: 'run-1',
          jobId: 'job-1',
          isScheduledJob: true,
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
      }),
    ).rejects.toThrow(
      'Tool not on autonomous run allowlist: denied_tool. Unattended jobs do not wait for approval.',
    );

    expect(model.callCount).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            payload: expect.objectContaining({
              phase: 'permission_denied',
              tool: 'denied_tool',
              terminal: true,
            }),
          }),
        ],
      }),
    );
  });
});
