import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { deepAgentsDenial } from '@core/adapters/llm/deepagents-langchain/runner/third-party-mcp-gate.js';
import {
  configureSetupPausePermissionPrompt,
  raiseSetupPausePermissionPrompt,
} from '@core/application/jobs/setup-pause-permission-prompt.js';
import {
  SETUP_REQUIRED_PAUSE_REASON,
  setupStateForDeniedTool,
} from '@core/application/jobs/job-readiness-service.js';

const previousAccessPreset = process.env.GANTRY_AGENT_ACCESS_PRESET;

beforeEach(() => {
  vi.clearAllMocks();
  harness.tools = [];
});

afterEach(() => {
  configureSetupPausePermissionPrompt(null);
  if (previousAccessPreset === undefined) {
    delete process.env.GANTRY_AGENT_ACCESS_PRESET;
  } else {
    process.env.GANTRY_AGENT_ACCESS_PRESET = previousAccessPreset;
  }
});

describe('DeepAgents terminal permission denial', () => {
  it('AUTODET-1-1 > deepagents lane observes identical terminal outcome for same grants', async () => {
    const [{ fakeModel }, { AIMessage }, { tool }] = await Promise.all([
      import('@langchain' + '/core/testing'),
      import('@langchain' + '/core/messages'),
      import('@langchain' + '/core/tools'),
    ]);
    const model = fakeModel()
      .respondWithTools([{ name: 'denied_tool', args: {} }])
      .respond(new AIMessage('should never continue'));
    harness.model = model;

    let gate:
      | {
          onPermissionDenied?: (input: {
            toolName: string;
            reason: string;
            grantable: boolean;
            recoveryAction: string;
          }) => never;
        }
      | undefined;
    const hostReason =
      'Autonomous runs decide deterministically: mcp__gantry__browser_open has no declared grant.';
    harness.tools = [
      tool(
        async () =>
          gate!.onPermissionDenied!(
            deepAgentsDenial(
              { capabilityRequestToolsHidden: false },
              'mcp__gantry__browser_open',
              {
                toolName: 'mcp__gantry__browser_open',
                toolInput: { url: 'https://example.com' },
              },
              hostReason,
            ),
          ),
        {
          name: 'denied_tool',
          description: 'Host deterministically denies an undeclared tool.',
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
          prompt: 'Use denied_tool.',
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
    ).rejects.toThrow('Permission denied for mcp__gantry__browser_open.');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            payload: expect.objectContaining({
              phase: 'permission_denied',
              terminal: true,
              grantable: true,
              reason: hostReason,
            }),
          }),
        ],
      }),
    );
  });

  it('a non-grantable locked-agent denial stays instruction-only with no approval offered', async () => {
    process.env.GANTRY_AGENT_ACCESS_PRESET = 'locked';
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
            grantable: boolean;
            recoveryAction: string;
          }) => never;
          capabilityRequestToolsHidden: boolean;
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
          return gate?.onPermissionDenied?.(
            deepAgentsDenial(
              gate!,
              'mcp__gantry__browser_open',
              {
                toolName: 'mcp__gantry__browser_open',
                toolInput: { url: 'https://example.com' },
              },
              'Grantable: true. Recovery: request_access {"target":{"kind":"capability","id":"browser.use"}} must not override the locked classification.',
            ),
          );
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

    let terminalError: Error | undefined;
    try {
      await runDeepAgentTurn({
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
      });
    } catch (error) {
      terminalError = error as Error;
    }

    expect(terminalError?.message).toContain(
      'Permission denied for mcp__gantry__browser_open.',
    );
    const recoveryAction =
      'Capability request tools are not available in this run (locked or fixed-image agent). Ask an operator to provision a reviewed capability covering mcp__gantry__browser_open before the run.';

    expect(model.callCount).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            payload: expect.objectContaining({
              phase: 'permission_denied',
              tool: 'mcp__gantry__browser_open',
              terminal: true,
              grantable: false,
              recovery_action: recoveryAction,
              denial_kind: 'permission_denied',
              provenance_lane: 'deepagents',
              provenance_seam: 'gate',
            }),
          }),
        ],
      }),
    );

    const setupState = setupStateForDeniedTool({
      toolName: 'mcp__gantry__browser_open',
      grantable: false,
      recoveryAction,
    });
    const runPermissionInteraction = vi.fn();
    const reviewStoredRequirement = vi.fn();
    configureSetupPausePermissionPrompt({
      appId: 'default',
      getJobById: vi.fn(
        async () =>
          ({
            id: 'job-1',
            app_id: 'default',
            name: 'locked browser job',
            workspace_key: 'agent-1',
            status: 'paused',
            pause_reason: SETUP_REQUIRED_PAUSE_REASON,
            setup_state: setupState,
            access_requirements: [],
            execution_context: { conversationJid: 'conversation:test' },
          }) as never,
      ),
      runPermissionInteraction,
      cancelPermissionApproval: vi.fn(async () => 'not_found'),
      reviewStoredRequirement,
    });

    await expect(
      raiseSetupPausePermissionPrompt({
        jobId: 'job-1',
        setupFingerprint: setupState.fingerprint,
      }),
    ).resolves.toEqual({
      status: 'instruction_only',
      notificationEligible: true,
    });
    expect(reviewStoredRequirement).not.toHaveBeenCalled();
    expect(runPermissionInteraction).not.toHaveBeenCalled();
  });

  it('an unlocked missing-grant denial offers the approval card', async () => {
    const denial = deepAgentsDenial(
      { capabilityRequestToolsHidden: false },
      'mcp__gantry__browser_open',
      {
        toolName: 'mcp__gantry__browser_open',
        toolInput: { url: 'https://example.com' },
      },
      'Unattended jobs do not wait for approval.',
    );
    expect(denial).toMatchObject({
      grantable: true,
      recoveryAction: expect.stringMatching(/^request_access /),
    });
    const setupState = setupStateForDeniedTool({
      toolName: denial.toolName,
      grantable: denial.grantable,
      recoveryAction: denial.recoveryAction,
    });
    const runPermissionInteraction = vi.fn(
      async (
        _request: unknown,
        onPromptDelivered: (messageId: string) => void,
        onInteractionBegan: () => void,
      ) => {
        onInteractionBegan();
        onPromptDelivered('message-1');
        return {
          began: true,
          resolved: true,
          decision: {
            approved: false,
            mode: 'cancel',
            reason: 'test cleanup',
          },
        } as never;
      },
    );
    const reviewStoredRequirement = vi.fn(async () => ({
      suggestions: [
        {
          type: 'addRules' as const,
          behavior: 'allow' as const,
          rules: [{ toolName: 'Browser' }],
        },
      ],
      decisionOptions: ['allow_persistent_rule' as const, 'cancel' as const],
    }));
    configureSetupPausePermissionPrompt({
      appId: 'default',
      getJobById: vi.fn(
        async () =>
          ({
            id: 'job-1',
            app_id: 'default',
            name: 'browser job',
            workspace_key: 'agent-1',
            status: 'paused',
            pause_reason: SETUP_REQUIRED_PAUSE_REASON,
            setup_state: setupState,
            access_requirements: [],
            execution_context: { conversationJid: 'conversation:test' },
          }) as never,
      ),
      runPermissionInteraction,
      cancelPermissionApproval: vi.fn(async () => 'not_found'),
      reviewStoredRequirement,
    });

    const result = await raiseSetupPausePermissionPrompt({
      jobId: 'job-1',
      setupFingerprint: setupState.fingerprint,
    });

    expect(result.status).toBe('raised');
    expect(reviewStoredRequirement).toHaveBeenCalledTimes(1);
    expect(runPermissionInteraction).toHaveBeenCalledTimes(1);
  });

  it('keeps the first parallel denial sticky and does not emit a second terminal event', async () => {
    const [{ fakeModel }, { AIMessage }, { tool }] = await Promise.all([
      import('@langchain' + '/core/testing'),
      import('@langchain' + '/core/messages'),
      import('@langchain' + '/core/tools'),
    ]);
    const model = fakeModel()
      .respondWithTools([
        { name: 'denied_a', args: {} },
        { name: 'denied_b', args: {} },
      ])
      .respond(new AIMessage('should never continue'));
    harness.model = model;

    let gate:
      | {
          onPermissionDenied?: (input: {
            toolName: string;
            reason: string;
            grantable: boolean;
            recoveryAction: string;
          }) => never;
          capabilityRequestToolsHidden: boolean;
          signal?: AbortSignal;
        }
      | undefined;
    let releaseB!: () => void;
    const bReleased = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    harness.tools = [
      tool(
        async () => {
          try {
            return gate!.onPermissionDenied!(
              deepAgentsDenial(
                gate!,
                'mcp__gantry__browser_open',
                {
                  toolName: 'mcp__gantry__browser_open',
                  toolInput: { url: 'https://a.example' },
                },
                'first denial',
              ),
            );
          } finally {
            // Release the sibling only after the first denial has registered.
            releaseB();
          }
        },
        {
          name: 'denied_a',
          description: 'First denial; terminates the turn.',
          schema: z.object({}),
        },
      ),
      tool(
        async () => {
          await bReleased;
          return gate!.onPermissionDenied!(
            deepAgentsDenial(
              gate!,
              'mcp__gantry__github_search',
              { toolName: 'mcp__gantry__github_search', toolInput: {} },
              'second denial',
            ),
          );
        },
        {
          name: 'denied_b',
          description: 'Late sibling denial; must not overwrite the first.',
          schema: z.object({}),
        },
      ),
    ];
    harness.connect.mockImplementationOnce(async (input) => {
      gate = input.gate;
      return { tools: harness.tools, close: harness.close };
    });
    const emit = vi.fn();

    let terminalError: Error | undefined;
    try {
      await runDeepAgentTurn({
        agentInput: {
          prompt: 'Call both tools in parallel.',
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
      });
    } catch (error) {
      terminalError = error as Error;
    }

    // The first denial owns the terminal error and the single emitted event;
    // the late sibling re-throws it without emitting a second terminal event.
    expect(terminalError?.message).toContain(
      'Permission denied for mcp__gantry__browser_open.',
    );
    const terminalEmits = emit.mock.calls.filter(([payload]) =>
      (
        payload as {
          runtimeEvents?: Array<{ payload?: { phase?: string } }>;
        }
      )?.runtimeEvents?.some(
        (event) => event.payload?.phase === 'permission_denied',
      ),
    );
    expect(terminalEmits).toHaveLength(1);
    expect(
      (
        terminalEmits[0]?.[0] as {
          runtimeEvents?: Array<{ payload?: { tool?: string } }>;
        }
      )?.runtimeEvents?.[0]?.payload?.tool,
    ).toBe('mcp__gantry__browser_open');
  });
});
