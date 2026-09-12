import { describe, expect, it, vi } from 'vitest';

import type { AgentOutput } from '@core/runtime/agent-spawn.js';
import { createGroupAgentRunner } from '@core/runtime/group-agent-runner.js';
import { buildProviderSessionAccessFingerprint } from '@core/runtime/provider-session-access-fingerprint.js';
import { stableSha256Json } from '@core/shared/stable-hash.js';

const EXECUTION_PROVIDER_ID = 'anthropic:claude-agent-sdk';
const CAP = 150_000;
const EMPTY_ACCESS_FINGERPRINT = buildProviderSessionAccessFingerprint({
  accessPreset: 'full',
  capabilityCatalogDigest: stableSha256Json({
    schemaVersion: 1,
    readyActions: [],
    requestableActions: [],
    installedSkills: [],
    connectedMcpSources: [],
  }),
});
const GROUP = {
  name: 'Main',
  folder: 'main_agent',
  added_at: new Date(0).toISOString(),
};
const USAGE = {
  model: 'sonnet',
  modelRoute: 'anthropic',
  inputTokens: 1_000,
  outputTokens: 10,
  cacheReadTokens: 270_000,
  cacheWriteTokens: 500,
  totalBillableInputTokens: 271_500,
  cacheProvider: 'anthropic',
  cacheStatus: 'partial',
  at: '2026-09-11T00:00:00.000Z',
} as const;

function context(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-one',
    agentId: 'agent:main_agent',
    agentSessionId: 'agent-session:main',
    agentSessionResetAt: null,
    providerSessionId: 'provider-session:old',
    externalSessionId: 'external-session:old',
    providerSessionAccessFingerprint: EMPTY_ACCESS_FINGERPRINT,
    contextHighWaterMark: 10_000,
    memoryContextBlock:
      '<gantry_memory_context>carried</gantry_memory_context>',
    ...overrides,
  };
}

function retired(externalSessionId = 'external-session:old') {
  return {
    providerSessionId: `retired:${externalSessionId}`,
    externalSessionId,
    executionProviderId: EXECUTION_PROVIDER_ID,
  };
}

function fixture(
  input: {
    attempts?: AgentOutput[][];
    getAgentTurnContext?: ReturnType<typeof vi.fn>;
    retireProviderSession?: ReturnType<typeof vi.fn>;
    publishRuntimeEvent?: ReturnType<typeof vi.fn>;
    setSession?: ReturnType<typeof vi.fn>;
    retiredProviderSessions?: ReturnType<typeof retired>[];
  } = {},
) {
  const attempts = input.attempts ?? [[{ status: 'success', result: 'reply' }]];
  const getAgentTurnContext =
    input.getAgentTurnContext ?? vi.fn(async () => context());
  const retireProviderSession =
    input.retireProviderSession ?? vi.fn(async () => retired());
  const publishRuntimeEvent =
    input.publishRuntimeEvent ?? vi.fn(async () => undefined);
  const setSession = input.setSession ?? vi.fn(async () => true);
  const raiseProviderSessionContextHighWaterMark = vi.fn(async () => true);
  const updateAgentRunProviderMetadata = vi.fn(async () => true);
  const delivered: AgentOutput[] = [];
  const runAgent = vi.fn(async (_group, _agentInput, _register, onOutput) => {
    const frames = attempts[runAgent.mock.calls.length - 1] ?? attempts.at(-1)!;
    for (const frame of frames) await onOutput?.(frame);
    return frames.at(-1)!;
  });
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
      publishRuntimeEvent,
      runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
      executionAdapter: { id: EXECUTION_PROVIDER_ID } as never,
      getSelectedAgentHarness: () => 'auto',
    },
    ops: () =>
      ({
        getAgentTurnContext,
        retireProviderSession,
        setSession,
        raiseProviderSessionContextHighWaterMark,
        createSessionAgentRun: vi.fn(async () => 'agent-run:one'),
        updateAgentRunProviderMetadata,
        completeSessionAgentRun: vi.fn(async () => undefined),
      }) as never,
  });
  const invoke = () =>
    runner(
      GROUP,
      'hello',
      'gantry:app-one:conversation:chat',
      'gantry:app-one:conversation:chat',
      async (output) => {
        delivered.push(output);
      },
      { retiredProviderSessions: input.retiredProviderSessions },
    );
  return {
    invoke,
    runAgent,
    getAgentTurnContext,
    retireProviderSession,
    publishRuntimeEvent,
    setSession,
    raiseProviderSessionContextHighWaterMark,
    updateAgentRunProviderMetadata,
    delivered,
  };
}

function retirementEvents(publishRuntimeEvent: ReturnType<typeof vi.fn>) {
  return publishRuntimeEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventType === 'session.provider.retired');
}

describe('group agent runner provider-session context ceiling', () => {
  it('raises the mark from a usage-bearing errored run and skips the raise without usage', async () => {
    const usage = fixture({
      attempts: [
        [{ status: 'error', result: null, error: 'boom', usage: USAGE }],
      ],
    });
    await expect(usage.invoke()).resolves.toBe('error');
    expect(usage.raiseProviderSessionContextHighWaterMark).toHaveBeenCalledWith(
      expect.objectContaining({ contextHighWaterMark: 271_500 }),
    );

    const noUsage = fixture({
      attempts: [[{ status: 'error', result: null, error: 'boom' }]],
    });
    await noUsage.invoke();
    expect(
      noUsage.raiseProviderSessionContextHighWaterMark,
    ).not.toHaveBeenCalled();
  });

  it('does not resume an over-cap session, retires it, and proceeds fresh', async () => {
    const getAgentTurnContext = vi.fn(async () =>
      context({ contextHighWaterMark: CAP + 1 }),
    );
    const test = fixture({ getAgentTurnContext });
    await expect(test.invoke()).resolves.toBe('success');
    expect(test.retireProviderSession).toHaveBeenCalledOnce();
    expect(test.runAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
  });

  it('persists the replacement handle and delivers the reply after retirement', async () => {
    const test = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({ contextHighWaterMark: CAP + 1 }),
      ),
      attempts: [
        [{ status: 'success', result: 'reply', newSessionId: 'replacement' }],
      ],
    });
    await test.invoke();
    expect(test.setSession).toHaveBeenCalledWith(
      'main_agent',
      'replacement',
      null,
      expect.any(Object),
    );
    expect(test.delivered.at(-1)?.result).toBe('reply');
  });

  it('retires a cap-crossing run on the following resume, not mid-run', async () => {
    const crossing = fixture({
      attempts: [[{ status: 'success', result: 'reply', usage: USAGE }]],
    });
    await crossing.invoke();
    expect(crossing.retireProviderSession).not.toHaveBeenCalled();
    expect(
      crossing.raiseProviderSessionContextHighWaterMark,
    ).toHaveBeenCalled();

    const nextTurn = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({ contextHighWaterMark: 271_500 }),
      ),
    });
    await nextTurn.invoke();
    expect(nextTurn.retireProviderSession).toHaveBeenCalledOnce();
  });

  it('promotes a ready row before the ceiling check', async () => {
    const getAgentTurnContext = vi.fn(async (request) =>
      request.promoteReadyProviderSession
        ? context({
            providerSessionId: 'provider-session:ready',
            externalSessionId: 'external-session:ready',
            contextHighWaterMark: CAP + 1,
          })
        : context({
            latestProviderSessionReady: true,
            readyProviderSessionId: 'provider-session:ready',
            readyExternalSessionId: 'external-session:ready',
            contextHighWaterMark: 1,
          }),
    );
    const test = fixture({ getAgentTurnContext });
    await test.invoke();
    expect(test.retireProviderSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: 'provider-session:ready' }),
    );
  });

  it('leaves a maintenance_compact row resumable', async () => {
    const test = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({
          contextHighWaterMark: CAP + 1,
          latestProviderSessionLocked: true,
        }),
      ),
    });
    await test.invoke();
    expect(test.retireProviderSession).not.toHaveBeenCalled();
    expect(test.runAgent.mock.calls[0][1].sessionId).toBe(
      'external-session:old',
    );
  });

  it('persists no replacement when the ceiling transition is lost', async () => {
    const test = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({ contextHighWaterMark: CAP + 1 }),
      ),
      retireProviderSession: vi.fn(async () => undefined),
      attempts: [
        [{ status: 'success', result: 'reply', newSessionId: 'replacement' }],
      ],
    });
    await test.invoke();
    expect(test.setSession).not.toHaveBeenCalled();
  });

  it('reuses the carried memory block when the generation still matches', async () => {
    const getAgentTurnContext = vi.fn(async (request) => {
      const call = getAgentTurnContext.mock.calls.length;
      if (call >= 3 && request.hydrateMemory === false) {
        return context({ memoryContextBlock: 'must-not-replace-carried' });
      }
      return context({ contextHighWaterMark: CAP + 1 });
    });
    const test = fixture({
      getAgentTurnContext,
      retireProviderSession: vi.fn(async () => undefined),
    });
    await test.invoke();
    expect(test.runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '>carried<',
    );
    expect(
      getAgentTurnContext.mock.calls.filter(
        ([request]) => request.hydrateMemory !== false,
      ),
    ).toHaveLength(1);
  });

  it('rehydrates the memory block when the generation changed', async () => {
    const getAgentTurnContext = vi.fn(async (request) => {
      const call = getAgentTurnContext.mock.calls.length;
      if (call === 3) {
        return context({ agentSessionResetAt: '2026-09-11T01:00:00.000Z' });
      }
      if (call === 4 && request.hydrateMemory === true) {
        return context({
          agentSessionResetAt: '2026-09-11T01:00:00.000Z',
          memoryContextBlock:
            '<gantry_memory_context>rehydrated</gantry_memory_context>',
        });
      }
      return context({ contextHighWaterMark: CAP + 1 });
    });
    const test = fixture({
      getAgentTurnContext,
      retireProviderSession: vi.fn(async () => undefined),
    });
    await test.invoke();
    expect(test.runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '>rehydrated<',
    );
    expect(getAgentTurnContext.mock.calls[3][0].hydrateMemory).toBe(true);
  });

  it('reuses carried memory when fingerprint retirement loses and the generation matches', async () => {
    const getAgentTurnContext = vi.fn(async (request) => {
      const call = getAgentTurnContext.mock.calls.length;
      if (call >= 3 && request.hydrateMemory === false) {
        return context({ memoryContextBlock: 'must-not-replace-carried' });
      }
      return context({ providerSessionAccessFingerprint: 'changed' });
    });
    const test = fixture({
      getAgentTurnContext,
      retireProviderSession: vi.fn(async () => undefined),
      attempts: [
        [{ status: 'success', result: 'reply', newSessionId: 'replacement' }],
      ],
    });
    await test.invoke();
    expect(test.runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '>carried<',
    );
    expect(test.setSession).not.toHaveBeenCalled();
    expect(
      getAgentTurnContext.mock.calls.filter(
        ([request]) => request.hydrateMemory !== false,
      ),
    ).toHaveLength(1);
  });

  it('rehydrates memory when fingerprint retirement loses and the generation changes', async () => {
    const getAgentTurnContext = vi.fn(async (request) => {
      const call = getAgentTurnContext.mock.calls.length;
      if (call === 3 && request.hydrateMemory === false) {
        return context({ agentSessionResetAt: '2026-09-11T01:00:00.000Z' });
      }
      if (call === 4 && request.hydrateMemory === true) {
        return context({
          agentSessionResetAt: '2026-09-11T01:00:00.000Z',
          memoryContextBlock:
            '<gantry_memory_context>rehydrated</gantry_memory_context>',
        });
      }
      return context({ providerSessionAccessFingerprint: 'changed' });
    });
    const test = fixture({
      getAgentTurnContext,
      retireProviderSession: vi.fn(async () => undefined),
      attempts: [
        [{ status: 'success', result: 'reply', newSessionId: 'replacement' }],
      ],
    });
    await test.invoke();
    expect(test.runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '>rehydrated<',
    );
    expect(test.setSession).not.toHaveBeenCalled();
    expect(getAgentTurnContext.mock.calls.at(-1)?.[0].hydrateMemory).toBe(true);
  });

  it('publishes the ceiling retirement at preflight with the agent session id and no run id', async () => {
    const test = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({ contextHighWaterMark: CAP + 1 }),
      ),
    });
    await test.invoke();
    expect(retirementEvents(test.publishRuntimeEvent)).toEqual([
      expect.objectContaining({
        sessionId: 'agent-session:main',
        payload: expect.objectContaining({
          reason: 'ceiling',
          providerSessionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          contextHighWaterMark: CAP + 1,
          cap: CAP,
        }),
      }),
    ]);
    expect(retirementEvents(test.publishRuntimeEvent)[0]).not.toHaveProperty(
      'runId',
    );
  });

  it("publishes the missing-session retirement with the failed attempt's run id", async () => {
    const test = fixture({
      attempts: [
        [
          {
            status: 'error',
            result: null,
            error: 'No conversation found with session ID',
          },
        ],
        [{ status: 'success', result: 'reply', newSessionId: 'replacement' }],
      ],
    });
    await test.invoke();
    expect(retirementEvents(test.publishRuntimeEvent)).toEqual([
      expect.objectContaining({
        sessionId: 'agent-session:main',
        runId: 'agent-run:one',
        payload: expect.objectContaining({
          reason: 'missing',
          providerSessionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    ]);
  });

  it('delivers the reply when retirement event publication fails', async () => {
    const publishRuntimeEvent = vi.fn(async (event) => {
      if (event.eventType === 'session.provider.retired')
        throw new Error('down');
    });
    const test = fixture({
      publishRuntimeEvent,
      getAgentTurnContext: vi.fn(async () =>
        context({ contextHighWaterMark: CAP + 1 }),
      ),
    });
    await expect(test.invoke()).resolves.toBe('success');
    expect(test.delivered.at(-1)?.result).toBe('reply');
  });

  it('collects every retired reference into the provided sink in retirement order', async () => {
    const sink: ReturnType<typeof retired>[] = [];
    const fingerprint = retired('external:fingerprint');
    await fixture({
      retiredProviderSessions: sink,
      getAgentTurnContext: vi.fn(async () =>
        context({
          externalSessionId: fingerprint.externalSessionId,
          providerSessionAccessFingerprint: 'changed',
        }),
      ),
      retireProviderSession: vi.fn(async () => fingerprint),
    }).invoke();
    const ceiling = retired('external:ceiling');
    await fixture({
      retiredProviderSessions: sink,
      getAgentTurnContext: vi.fn(async () =>
        context({
          externalSessionId: ceiling.externalSessionId,
          contextHighWaterMark: CAP + 1,
        }),
      ),
      retireProviderSession: vi.fn(async () => ceiling),
    }).invoke();
    const missing = retired('external:missing');
    await fixture({
      retiredProviderSessions: sink,
      attempts: [
        [{ status: 'error', result: null, error: 'provider session missing' }],
        [{ status: 'success', result: 'reply' }],
      ],
      retireProviderSession: vi.fn(async () => missing),
    }).invoke();
    expect(sink).toEqual([fingerprint, ceiling, missing]);
  });

  it('publishes the fingerprint retirement at preflight with no run id', async () => {
    const test = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({
          providerSessionAccessFingerprint: 'changed',
          contextHighWaterMark: CAP + 1,
        }),
      ),
    });
    await test.invoke();
    expect(retirementEvents(test.publishRuntimeEvent)[0]).toEqual(
      expect.objectContaining({
        sessionId: 'agent-session:main',
        payload: expect.objectContaining({
          reason: 'fingerprint',
          providerSessionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    );
    expect(test.retireProviderSession).toHaveBeenCalledOnce();
    expect(retirementEvents(test.publishRuntimeEvent)[0]).not.toHaveProperty(
      'runId',
    );
  });

  it("records a mark on a fresh session's first turn", async () => {
    const test = fixture({
      getAgentTurnContext: vi.fn(async () =>
        context({ providerSessionId: undefined, externalSessionId: undefined }),
      ),
      attempts: [
        [
          {
            status: 'success',
            result: 'reply',
            newSessionId: 'fresh-session',
            contextUsage: {
              totalTokens: 42_000,
              maxTokens: 200_000,
              percentage: 21,
              categories: [],
              at: '2026-09-11T00:00:00.000Z',
            },
          },
        ],
      ],
    });
    await test.invoke();
    expect(test.raiseProviderSessionContextHighWaterMark).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'fresh-session',
        externalSessionId: 'fresh-session',
        contextHighWaterMark: 42_000,
      }),
    );
  });

  it('keeps an under-cap or unmarked session resumable with its memory block', async () => {
    for (const contextHighWaterMark of [CAP, undefined]) {
      const test = fixture({
        getAgentTurnContext: vi.fn(async () =>
          context({ contextHighWaterMark }),
        ),
      });
      await test.invoke();
      expect(test.retireProviderSession).not.toHaveBeenCalled();
      expect(test.runAgent.mock.calls[0][1]).toMatchObject({
        sessionId: 'external-session:old',
        memoryContextBlock: expect.stringContaining('carried'),
      });
    }
  });
});
