import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentExecutionAdapterRegistry } from '@core/application/agent-execution/agent-execution-adapter-registry.js';
import type { AgentOutput } from '@core/runtime/agent-spawn.js';
import { createGroupAgentRunner } from '@core/runtime/group-agent-runner.js';

const failover = vi.hoisted(() => ({
  initialProvider: 'anthropic:claude-agent-sdk',
  targetProvider: undefined as string | undefined,
}));

vi.mock('@core/runtime/group-initial-execution-provider.js', () => ({
  resolveInitialGroupExecutionProviderId: vi.fn(async () => ({
    executionProviderId: failover.initialProvider,
    firstModel: 'first-model',
    failoverCandidates: failover.targetProvider
      ? ['first-model', 'second-model']
      : [],
    initialModelSelection: {
      modelAlias: 'first-model',
      selectionSource: 'test',
    },
  })),
}));

vi.mock('@core/runtime/failover-candidate-loop.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@core/runtime/failover-candidate-loop.js')
    >();
  return {
    ...actual,
    runFamilyFailoverLoop: vi.fn(async (input) => {
      if (!failover.targetProvider) return input.initialOutput;
      input.onFailover(failover.targetProvider as never, {
        toProviderId: failover.targetProvider as never,
        fromModel: 'first-model',
        toModel: 'second-model',
        reason: input.initialOutput.error,
      });
      return input.invoke('second-model');
    }),
  };
});

const CLAUDE = 'anthropic:claude-agent-sdk';
const DEEPAGENTS = 'deepagents:langchain';
const ACCESS_FINGERPRINT =
  'provider-session-access:v2:1e40d128c674ea257f92e216d49840ae3816fc0b43b8b15eff4012eed7bc2d0c';

function turnContext(provider: string | undefined) {
  return {
    appId: 'app-one',
    agentId: 'agent:main',
    agentSessionId: 'agent-session:one',
    agentSessionResetAt: null,
    memoryContextBlock: '<gantry_memory_context>one</gantry_memory_context>',
    ...(provider
      ? {
          providerSessionId: `provider:${provider}`,
          externalSessionId: `external:${provider}`,
          providerSessionAccessFingerprint: ACCESS_FINGERPRINT,
        }
      : {}),
  };
}

function fixture(input?: {
  firstOutput?: AgentOutput;
  secondOutput?: AgentOutput;
  updateAgentRunProviderMetadata?: ReturnType<typeof vi.fn>;
}) {
  const contexts: Array<Record<string, unknown>> = [];
  const getAgentTurnContext = vi.fn(async (selection) => {
    contexts.push(selection);
    return selection.providerSessionContinuity === 'durable_resume'
      ? turnContext(DEEPAGENTS)
      : turnContext(undefined);
  });
  const createSessionAgentRun = vi.fn(async () => 'run:one');
  const updateAgentRunProviderMetadata =
    input?.updateAgentRunProviderMetadata ?? vi.fn(async () => true);
  const setSession = vi.fn(async () => true);
  const retireProviderSession = vi.fn(async () => undefined);
  const raiseProviderSessionContextHighWaterMark = vi.fn(async () => true);
  const outputs = [
    input?.firstOutput ?? { status: 'success', result: 'ok' },
    input?.secondOutput ?? { status: 'success', result: 'fallback-ok' },
  ];
  const runAgent = vi.fn(
    async (_group, _agentInput, registerProcess, onOutput) => {
      const index = runAgent.mock.calls.length - 1;
      registerProcess?.({} as never, `provider-run:${index + 1}`);
      const output = outputs[index] ?? outputs.at(-1)!;
      await onOutput?.(output);
      return output;
    },
  );
  const executionAdapters = createAgentExecutionAdapterRegistry([
    {
      id: CLAUDE,
      providerSessionContinuity: 'process_local',
      prepare: vi.fn(),
    } as never,
    {
      id: DEEPAGENTS,
      providerSessionContinuity: 'durable_resume',
      prepare: vi.fn(),
    } as never,
  ]);
  const runner = createGroupAgentRunner({
    deps: {
      channelRuntime: {
        hasChannel: () => true,
        supportsStreaming: () => false,
        supportsProgress: () => false,
        sendMessage: async () => {},
        sendStreamingChunk: async () => false,
        resetStreaming: () => {},
        setTyping: async () => {},
        sendProgressUpdate: async () => {},
      },
      queue: {
        enqueueMessageCheck: () => false,
        closeStdin: () => {},
        notifyIdle: () => {},
        registerProcess: () => {},
      },
      getGroup: () => undefined,
      clearSession: async () => {},
      getCursor: () => '',
      setCursor: () => {},
      saveState: async () => {},
      setGroupModelOverride: async () => {},
      setGroupThinkingOverride: async () => {},
      setGroupPermissionModeOverride: async () => {},
      getAvailableGroups: () => [],
      getRegisteredJids: () => new Set(),
      runAgent: runAgent as never,
      publishRuntimeEvent: vi.fn(async () => undefined),
      runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
      executionAdapter: executionAdapters.get(CLAUDE),
      executionAdapters,
      getSelectedAgentHarness: () => 'auto',
    },
    ops: () =>
      ({
        getAgentTurnContext,
        createSessionAgentRun,
        updateAgentRunProviderMetadata,
        completeSessionAgentRun: vi.fn(async () => undefined),
        setSession,
        retireProviderSession,
        raiseProviderSessionContextHighWaterMark,
      }) as never,
  });
  const invoke = () =>
    runner(
      {
        name: 'Main',
        folder: 'main',
        added_at: new Date(0).toISOString(),
      },
      'hello',
      'gantry:app-one:conversation:one',
      'gantry:app-one:conversation:one',
      async () => {},
    );
  return {
    contexts,
    invoke,
    runAgent,
    createSessionAgentRun,
    updateAgentRunProviderMetadata,
    setSession,
    retireProviderSession,
    raiseProviderSessionContextHighWaterMark,
  };
}

describe('provider-session continuity', () => {
  beforeEach(() => {
    failover.initialProvider = CLAUDE;
    failover.targetProvider = undefined;
  });

  it('starts a recovered Claude worker without a resume id or persisted handle', async () => {
    const test = fixture({
      firstOutput: {
        status: 'success',
        result: 'fresh',
        newSessionId: 'claude-handle',
      },
    });

    await test.invoke();

    expect(test.runAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
    expect(test.setSession).not.toHaveBeenCalled();
    expect(test.updateAgentRunProviderMetadata).not.toHaveBeenCalled();
  });

  it('starts every Claude inline attempt without resume or persistence', () => {
    const registry = createAgentExecutionAdapterRegistry([
      {
        id: CLAUDE,
        providerSessionContinuity: 'process_local',
        prepare: vi.fn(),
      } as never,
    ]);

    expect(registry.get(CLAUDE)?.providerSessionContinuity).toBe(
      'process_local',
    );
  });

  it('filters a stale process-local row before run creation and lifecycle', async () => {
    const test = fixture();

    await test.invoke();

    expect(test.contexts[0]).toMatchObject({
      providerSessionContinuity: 'process_local',
    });
    expect(test.createSessionAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: undefined }),
    );
    expect(test.retireProviderSession).not.toHaveBeenCalled();
    expect(
      test.raiseProviderSessionContextHighWaterMark,
    ).not.toHaveBeenCalled();
  });

  it('keeps provider-session state attempt-local across DeepAgents to Claude failover', async () => {
    failover.initialProvider = DEEPAGENTS;
    failover.targetProvider = CLAUDE;
    const test = fixture({
      firstOutput: {
        status: 'error',
        result: null,
        error: 'API Error: 401 invalid key',
      },
      secondOutput: {
        status: 'success',
        result: 'fresh Claude reply',
        newSessionId: 'claude-handle',
      },
    });

    await test.invoke();

    expect(test.runAgent.mock.calls[0][1]).toMatchObject({
      sessionId: `external:${DEEPAGENTS}`,
    });
    expect(test.runAgent.mock.calls[1][1]).not.toHaveProperty('sessionId');
    expect(test.setSession).not.toHaveBeenCalled();
    expect(test.updateAgentRunProviderMetadata).toHaveBeenLastCalledWith({
      runId: 'run:one',
      providerRunId: null,
      providerSessionId: null,
    });
  });

  it('stops process-local failover when provider run linkage cannot be cleared', async () => {
    failover.initialProvider = DEEPAGENTS;
    failover.targetProvider = CLAUDE;
    const updateAgentRunProviderMetadata = vi.fn(async (input) => {
      if (input.providerRunId === null) throw new Error('clear failed');
      return true;
    });
    const test = fixture({
      firstOutput: {
        status: 'error',
        result: null,
        error: 'API Error: 401 invalid key',
      },
      updateAgentRunProviderMetadata,
    });

    await expect(test.invoke()).resolves.toBe('error');

    expect(test.runAgent).toHaveBeenCalledOnce();
    expect(updateAgentRunProviderMetadata).toHaveBeenCalledWith({
      runId: 'run:one',
      providerRunId: null,
      providerSessionId: null,
    });
  });

  it('clears failover linkage after the previous provider run link settles', async () => {
    failover.initialProvider = DEEPAGENTS;
    failover.targetProvider = CLAUDE;
    let releaseProviderRunLink: (() => void) | undefined;
    const updateAgentRunProviderMetadata = vi.fn(async (input) => {
      if (typeof input.providerRunId === 'string') {
        await new Promise<void>((resolve) => {
          releaseProviderRunLink = resolve;
        });
      }
      return true;
    });
    const test = fixture({
      firstOutput: {
        status: 'error',
        result: null,
        error: 'API Error: 401 invalid key',
      },
      updateAgentRunProviderMetadata,
    });

    const result = test.invoke();
    await vi.waitFor(() =>
      expect(releaseProviderRunLink).toBeTypeOf('function'),
    );
    expect(
      updateAgentRunProviderMetadata.mock.calls.some(
        ([input]) => input.providerRunId === null,
      ),
    ).toBe(false);
    releaseProviderRunLink?.();

    await expect(result).resolves.toBe('success');
    expect(updateAgentRunProviderMetadata).toHaveBeenLastCalledWith({
      runId: 'run:one',
      providerRunId: null,
      providerSessionId: null,
    });
  });

  it('reselects durable state without rehydrating memory across Claude to DeepAgents failover', async () => {
    failover.initialProvider = CLAUDE;
    failover.targetProvider = DEEPAGENTS;
    const test = fixture({
      firstOutput: {
        status: 'error',
        result: null,
        error: 'API Error: 401 invalid key',
      },
    });

    await test.invoke();

    expect(test.runAgent.mock.calls[1][1]).toMatchObject({
      sessionId: `external:${DEEPAGENTS}`,
      memoryContextBlock: expect.stringContaining('one'),
    });
    expect(test.contexts[0]).toMatchObject({
      providerSessionContinuity: 'process_local',
      hydrateMemory: true,
    });
    expect(
      test.contexts.filter(
        ({ providerSessionContinuity }) =>
          providerSessionContinuity === 'durable_resume',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hydrateMemory: false }),
      ]),
    );
    expect(
      test.contexts
        .slice(1)
        .some(({ hydrateMemory }) => hydrateMemory === true),
    ).toBe(false);
  });
});
