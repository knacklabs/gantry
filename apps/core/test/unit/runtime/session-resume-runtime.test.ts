import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentSessionRepository } from '@core/domain/repositories/ops-repo.js';
import { createGroupAgentRunner } from '@core/runtime/group-agent-runner.js';
import { currentLogContext } from '@core/infrastructure/logging/logger.js';
import { buildProviderSessionAccessFingerprint } from '@core/runtime/provider-session-access-fingerprint.js';
import { stableSha256Json } from '@core/shared/stable-hash.js';
import {
  buildApprovedSkillContextBlockFromSkills,
  createRuntimeResultSummaryAccumulator,
  completeSuccessfulRuntimeSessionRun,
  completeFailedRuntimeSessionRun,
  RUNTIME_RESULT_SUMMARY_MAX_CHARS,
  summarizeRuntimeResultForPersistence,
  truncateRuntimeResultSummary,
} from '@core/runtime/session-resume-runtime.js';

const EMPTY_ACCESS_FINGERPRINT = buildProviderSessionAccessFingerprint({
  accessPreset: 'full',
  capabilityCatalogDigest: stableSha256Json({
    schemaVersion: 1,
    readyActions: [],
    installedSkills: [],
    connectedMcpSources: [],
  }),
});

function createCompactionPathRunner(input: {
  getAgentTurnContext: ReturnType<typeof vi.fn>;
  getContextMessagesSince?: ReturnType<typeof vi.fn>;
  markProviderSessionDeltaReplay?: ReturnType<typeof vi.fn>;
  expireProviderSession?: ReturnType<typeof vi.fn>;
}) {
  const runAgent = vi.fn(
    async (
      _group: unknown,
      _input: { memoryContextBlock?: string },
      _register?: unknown,
      _onOutput?: unknown,
    ) => ({ status: 'success', result: 'ok' }),
  );
  const executionProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
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
      runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
      executionAdapter: { id: executionProviderId } as never,
      getSelectedAgentHarness: () => 'auto',
    },
    ops: () =>
      ({
        getAgentTurnContext: input.getAgentTurnContext,
        getContextMessagesSince: input.getContextMessagesSince,
        markProviderSessionDeltaReplay: input.markProviderSessionDeltaReplay,
        expireProviderSession: input.expireProviderSession,
      }) as never,
  });
  return { runner, runAgent, executionProviderId };
}

describe('session-resume-runtime', () => {
  it('publishes one durable usage event per live-turn usage event id', async () => {
    const usage = {
      model: 'sonnet',
      provider: ['anth', 'ropic'].join('') as never,
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 12,
      cacheProvider: 'anthropic',
      cacheStatus: 'unknown',
      at: '2026-07-11T00:00:00.000Z',
    } as const;
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const liveRoutes = {
      'tg:chat': {
        name: 'Main',
        folder: 'main_agent',
        trigger: '@gantry',
        added_at: new Date(0).toISOString(),
        conversationId: 'conversation:live',
      },
    };
    let observedLogContext: ReturnType<typeof currentLogContext> = undefined;
    const runAgent = vi.fn(async (_group, input, _register, onOutput) => {
      observedLogContext = currentLogContext();
      await onOutput?.({
        status: 'success',
        result: null,
        usage,
        usageEventId: 'usage:live-turn-1',
      });
      await onOutput?.({
        status: 'success',
        result: null,
        usage,
        usageEventId: 'usage:live-turn-1',
      });
      return { status: 'success', result: 'ok' };
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
        getConversationRoutes: () => liveRoutes,
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
        executionAdapter: {
          id: ['anth', 'ropic:claude-agent-sdk'].join(''),
        } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'app-one',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
          })),
          createSessionAgentRun: vi.fn(async () => 'run:live-turn-1'),
        }) as never,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
          agentConfig: { model: 'sonnet' },
        },
        'hello',
        'tg:chat',
        'tg:chat',
      ),
    ).resolves.toBe('success');
    expect(runAgent.mock.calls[0]?.[4]).toMatchObject({
      conversationRoutes: liveRoutes,
    });

    const usageEvents = publishRuntimeEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventType === 'model.usage');
    expect(usageEvents).toEqual([
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent:main_agent',
        runId: 'run:live-turn-1',
        payload: expect.objectContaining({
          usage,
          usageEventId: 'usage:live-turn-1',
          modelAlias: 'sonnet',
          providerId: 'anthropic',
        }),
      }),
    ]);
    expect(runAgent.mock.calls[0]?.[1]).not.toHaveProperty('runId');
    expect(runAgent.mock.calls[0]?.[4]).toMatchObject({
      correlationRunId: 'run:live-turn-1',
    });
    expect(observedLogContext).toEqual({
      runId: 'run:live-turn-1',
      appId: 'app-one',
      agentId: 'agent:main_agent',
    });
  });

  it('runs maintenance-locked provider sessions without resume or head writes', async () => {
    const setSession = vi.fn();
    const getAgentTurnContext = vi.fn(
      async (_input: { hydrateMemory?: boolean }) => ({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'agent-session:main',
        latestProviderSessionLocked: true,
        lockedProviderSessionId: 'provider-session:locked',
      }),
    );
    const runAgent = vi.fn(async (_group, input, _register, onOutput) => {
      await onOutput?.({
        status: 'success',
        result: 'ok',
        newSessionId: 'provider-session:ephemeral',
      });
      return {
        status: 'success',
        result: 'ok',
        newSessionId: 'provider-session:ephemeral',
      };
    });
    const defaultProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
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
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: defaultProviderId } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext,
          setSession,
        }) as unknown as RuntimeAgentSessionRepository,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
        },
        'hello',
        'tg:chat',
        'tg:chat',
      ),
    ).resolves.toBe('success');

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ promoteReadyProviderSession: true }),
    );
    expect(runAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
    expect(setSession).not.toHaveBeenCalled();
  });

  it('uses the provisional memory block with one hydration for a maintenance session', async () => {
    const provisionalBlock =
      '<gantry_memory_context>LAT-3A maintenance provisional</gantry_memory_context>';
    const getAgentTurnContext = vi.fn(
      async (_input: { hydrateMemory?: boolean }) => ({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'agent-session:maintenance',
        agentSessionResetAt: 'T1',
        memoryContextBlock: provisionalBlock,
      }),
    );
    const { runner, runAgent } = createCompactionPathRunner({
      getAgentTurnContext,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
        },
        'hello',
        'tg:chat',
        'tg:chat',
        undefined,
        {
          maintenanceProviderSession: {
            providerSessionId: 'provider-session:maintenance',
            externalSessionId: 'provider-session:maintenance',
          },
        },
      ),
    ).resolves.toBe('success');

    expect(getAgentTurnContext).toHaveBeenCalledTimes(1);
    expect(
      getAgentTurnContext.mock.calls.filter(
        ([input]) => input.hydrateMemory !== false,
      ),
    ).toHaveLength(1);
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      provisionalBlock,
    );
  });

  it('carries the provisional memory block with one hydration when no delta is pending', async () => {
    const provisionalBlock =
      '<gantry_memory_context>LAT-3A ordinary provisional</gantry_memory_context>';
    const laterBlock =
      '<gantry_memory_context>LAT-3A ordinary non-hydrating read</gantry_memory_context>';
    const getAgentTurnContext = vi
      .fn()
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'agent-session:ordinary',
        agentSessionResetAt: 'T1',
        memoryContextBlock: provisionalBlock,
      })
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'agent-session:ordinary',
        agentSessionResetAt: 'T1',
        memoryContextBlock: laterBlock,
      });
    const { runner, runAgent } = createCompactionPathRunner({
      getAgentTurnContext,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
        },
        'hello',
        'tg:chat',
        'tg:chat',
      ),
    ).resolves.toBe('success');

    expect(getAgentTurnContext).toHaveBeenCalledTimes(2);
    expect(
      getAgentTurnContext.mock.calls.filter(
        ([input]) => input.hydrateMemory !== false,
      ),
    ).toHaveLength(1);
    const modelMemoryBlock = runAgent.mock.calls[0][1]
      .memoryContextBlock as string;
    expect(modelMemoryBlock).toContain(provisionalBlock);
    expect(modelMemoryBlock).not.toContain(laterBlock);
  });

  it.each([
    {
      label: 'too stale',
      lockedAt: '2000-01-01T00:00:00.000Z',
      messages: [],
      reason: 'stale',
    },
    {
      label: 'too large',
      lockedAt: new Date().toISOString(),
      messages: Array.from({ length: 51 }, (_, index) => ({
        id: `delta-${index}`,
      })),
      reason: 'too_large',
    },
  ])(
    'carries the provisional memory block with one hydration when the delta is $label',
    async ({ lockedAt, messages, reason }) => {
      const provisionalBlock =
        '<gantry_memory_context>LAT-3A degraded provisional</gantry_memory_context>';
      const laterBlock =
        '<gantry_memory_context>LAT-3A degraded non-hydrating read</gantry_memory_context>';
      const getAgentTurnContext = vi
        .fn()
        .mockResolvedValueOnce({
          appId: 'default',
          agentId: 'agent:main_agent',
          agentSessionId: 'agent-session:degraded',
          agentSessionResetAt: 'T1',
          latestProviderSessionReady: true,
          readyProviderSessionId: 'provider-session:ready',
          readyExternalSessionId: 'provider-session:ready',
          compactionDeltaReplay: {
            status: 'pending',
            baseCursor: 'cursor:base',
            lockedAt,
          },
          memoryContextBlock: provisionalBlock,
        })
        .mockResolvedValueOnce({
          appId: 'default',
          agentId: 'agent:main_agent',
          agentSessionId: 'agent-session:degraded',
          agentSessionResetAt: 'T1',
          memoryContextBlock: laterBlock,
        });
      const getContextMessagesSince = vi.fn(async () => messages);
      const markProviderSessionDeltaReplay = vi.fn(async () => undefined);
      const expireProviderSession = vi.fn(async () => undefined);
      const { runner, runAgent } = createCompactionPathRunner({
        getAgentTurnContext,
        getContextMessagesSince,
        markProviderSessionDeltaReplay,
        expireProviderSession,
      });

      await expect(
        runner(
          {
            name: 'Main',
            folder: 'main_agent',
            added_at: new Date(0).toISOString(),
          },
          'hello',
          'tg:chat',
          'tg:chat',
        ),
      ).resolves.toBe('success');

      expect(getAgentTurnContext).toHaveBeenCalledTimes(2);
      expect(
        getAgentTurnContext.mock.calls.filter(
          ([input]) => input.hydrateMemory !== false,
        ),
      ).toHaveLength(1);
      const modelMemoryBlock = runAgent.mock.calls[0][1]
        .memoryContextBlock as string;
      expect(modelMemoryBlock).toContain(provisionalBlock);
      expect(modelMemoryBlock).not.toContain(laterBlock);
      expect(markProviderSessionDeltaReplay).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'degraded', reason }),
      );
      expect(expireProviderSession).toHaveBeenCalledTimes(1);
    },
  );

  it('drops pending-delta replay when the session resets before the model call', async () => {
    const provisionalBlock =
      '<gantry_memory_context>LAT-3A pending replay before reset</gantry_memory_context>';
    const revalidationBlock =
      '<gantry_memory_context>LAT-3A pending replay non-hydrating revalidation</gantry_memory_context>';
    const resetBlock =
      '<gantry_memory_context>LAT-3A pending replay after reset</gantry_memory_context>';
    const getAgentTurnContext = vi
      .fn()
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'S1',
        agentSessionResetAt: 'T1',
        latestProviderSessionReady: true,
        readyProviderSessionId: 'provider-session:ready',
        readyExternalSessionId: 'provider-session:ready',
        compactionDeltaReplay: {
          status: 'pending',
          baseCursor: 'cursor:base',
          lockedAt: new Date().toISOString(),
        },
        memoryContextBlock: provisionalBlock,
      })
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'S1',
        agentSessionResetAt: 'T2',
        memoryContextBlock: revalidationBlock,
      })
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'S1',
        agentSessionResetAt: 'T2',
        memoryContextBlock: resetBlock,
      });
    const getContextMessagesSince = vi.fn(async () => [
      {
        id: '2',
        chat_jid: 'tg:chat',
        sender: 'user-1',
        content: 'pending replay message',
        timestamp: '2026-04-28T00:00:02.000Z',
        is_from_me: false,
      },
    ]);
    const { runner, runAgent } = createCompactionPathRunner({
      getAgentTurnContext,
      getContextMessagesSince,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
        },
        'hello',
        'tg:chat',
        'tg:chat',
      ),
    ).resolves.toBe('success');

    const modelMemoryBlock = runAgent.mock.calls[0][1]
      .memoryContextBlock as string;
    expect(modelMemoryBlock).toContain(resetBlock);
    expect(modelMemoryBlock).not.toContain(provisionalBlock);
    expect(modelMemoryBlock).not.toContain('<gantry_compaction_delta>');
    expect(getAgentTurnContext.mock.calls[1][0].hydrateMemory).toBe(false);
    expect(getAgentTurnContext.mock.calls[2][0].hydrateMemory).toBe(true);
  });

  it('keeps pending-delta replay with one hydration when the session identity matches', async () => {
    const provisionalBlock =
      '<gantry_memory_context>LAT-3A pending replay matching provisional</gantry_memory_context>';
    const revalidationBlock =
      '<gantry_memory_context>LAT-3A pending replay matching revalidation</gantry_memory_context>';
    const markAppliedBlock =
      '<gantry_memory_context>LAT-3A pending replay matching mark applied</gantry_memory_context>';
    const getAgentTurnContext = vi
      .fn()
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'S1',
        agentSessionResetAt: 'T1',
        latestProviderSessionReady: true,
        readyProviderSessionId: 'provider-session:ready',
        readyExternalSessionId: 'provider-session:ready',
        compactionDeltaReplay: {
          status: 'pending',
          baseCursor: 'cursor:base',
          lockedAt: new Date().toISOString(),
        },
        memoryContextBlock: provisionalBlock,
      })
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'S1',
        agentSessionResetAt: 'T1',
        memoryContextBlock: revalidationBlock,
      })
      .mockResolvedValueOnce({
        appId: 'default',
        agentId: 'agent:main_agent',
        agentSessionId: 'S1',
        agentSessionResetAt: 'T1',
        providerSessionId: 'provider-session:ready',
        externalSessionId: 'provider-session:ready',
        memoryContextBlock: markAppliedBlock,
      });
    const getContextMessagesSince = vi.fn(async () => [
      {
        id: '2',
        chat_jid: 'tg:chat',
        sender: 'user-1',
        content: 'pending replay message',
        timestamp: '2026-04-28T00:00:02.000Z',
        is_from_me: false,
      },
    ]);
    const { runner, runAgent } = createCompactionPathRunner({
      getAgentTurnContext,
      getContextMessagesSince,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
        },
        'hello',
        'tg:chat',
        'tg:chat',
      ),
    ).resolves.toBe('success');

    const modelMemoryBlock = runAgent.mock.calls[0][1]
      .memoryContextBlock as string;
    expect(modelMemoryBlock).toContain(provisionalBlock);
    expect(modelMemoryBlock).toContain('<gantry_compaction_delta>');
    expect(modelMemoryBlock).not.toContain(revalidationBlock);
    expect(modelMemoryBlock).not.toContain(markAppliedBlock);
    expect(
      getAgentTurnContext.mock.calls.filter(
        ([input]) => input.hydrateMemory !== false,
      ),
    ).toHaveLength(1);
  });

  it('injects compacted-session transcript delta before resumed turn', async () => {
    const markProviderSessionDeltaReplay = vi.fn();
    const accessFingerprint = EMPTY_ACCESS_FINGERPRINT;
    const provisionalBlock =
      '<gantry_memory_context>LAT-3A replay provisional</gantry_memory_context>';
    const promotedBlock =
      '<gantry_memory_context>LAT-3A replay mark-applied read</gantry_memory_context>';
    const getAgentTurnContext = vi.fn(async (input) =>
      input.promoteReadyProviderSession
        ? {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            providerSessionId: 'provider-session:ready',
            externalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
            memoryContextBlock: promotedBlock,
          }
        : {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            latestProviderSessionReady: true,
            readyProviderSessionId: 'provider-session:ready',
            readyExternalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
            memoryContextBlock: provisionalBlock,
          },
    );
    const getContextMessagesSince = vi.fn(async () => [
      {
        id: '2',
        chat_jid: 'tg:chat',
        sender: 'user-1',
        content: 'overlap question',
        timestamp: '2026-04-28T00:00:02.000Z',
        is_from_me: false,
      },
      {
        id: '3',
        chat_jid: 'tg:chat',
        sender: 'bot',
        content: 'overlap answer',
        timestamp: '2026-04-28T00:00:03.000Z',
        is_from_me: true,
      },
    ]);
    const runAgent = vi.fn(
      async (
        _group: unknown,
        _input: { sessionId?: string; memoryContextBlock?: string },
        _register?: unknown,
        _onOutput?: unknown,
      ) => ({ status: 'success', result: 'ok' }),
    );
    const defaultProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
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
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: defaultProviderId } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext,
          getContextMessagesSince,
          markProviderSessionDeltaReplay,
        }) as never,
    });

    await runner(
      {
        name: 'Main',
        folder: 'main_agent',
        added_at: new Date(0).toISOString(),
      },
      'hello',
      'tg:chat',
      'tg:chat',
    );

    expect(getContextMessagesSince).toHaveBeenCalledWith(
      'tg:chat',
      'cursor:base',
      51,
      { threadId: null, providerAccountId: undefined },
    );
    expect(runAgent.mock.calls[0][1].sessionId).toBe('provider-session:ready');
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '<gantry_compaction_delta>',
    );
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      'overlap question',
    );
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      'overlap answer',
    );
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      provisionalBlock,
    );
    expect(runAgent.mock.calls[0][1].memoryContextBlock).not.toContain(
      promotedBlock,
    );
    expect(getAgentTurnContext).toHaveBeenCalledTimes(3);
    expect(
      getAgentTurnContext.mock.calls.filter(
        ([input]) => input.hydrateMemory !== false,
      ),
    ).toHaveLength(1);
    expect(getAgentTurnContext.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        promoteReadyProviderSession: true,
        hydrateMemory: false,
      }),
    );
    expect(markProviderSessionDeltaReplay).toHaveBeenCalledWith({
      providerSessionId: 'provider-session:ready',
      agentSessionId: 'agent-session:main',
      provider: defaultProviderId,
      externalSessionId: 'provider-session:ready',
      status: 'applied',
      compactionBaseCursor: 'cursor:base',
    });
  });

  it('keeps compacted-session delta replay pending when the first resumed turn fails', async () => {
    const markProviderSessionDeltaReplay = vi.fn();
    const accessFingerprint = EMPTY_ACCESS_FINGERPRINT;
    const getAgentTurnContext = vi.fn(async (input) =>
      input.promoteReadyProviderSession
        ? {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            providerSessionId: 'provider-session:ready',
            externalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
          }
        : {
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
            latestProviderSessionReady: true,
            readyProviderSessionId: 'provider-session:ready',
            readyExternalSessionId: 'provider-session:ready',
            providerSessionAccessFingerprint: accessFingerprint,
            compactionDeltaReplay: {
              status: 'pending',
              baseCursor: 'cursor:base',
              lockedAt: new Date().toISOString(),
            },
          },
    );
    const getContextMessagesSince = vi.fn(async () => [
      {
        id: '2',
        chat_jid: 'tg:chat',
        sender: 'user-1',
        content: 'overlap question',
        timestamp: '2026-04-28T00:00:02.000Z',
        is_from_me: false,
      },
    ]);
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({ status: 'error', result: null, error: 'boom' })
      .mockResolvedValueOnce({ status: 'success', result: 'ok' });
    const defaultProviderId = ['anth', 'ropic:claude-agent-sdk'].join('');
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
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: defaultProviderId } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext,
          getContextMessagesSince,
          markProviderSessionDeltaReplay,
        }) as never,
    });

    const group = {
      name: 'Main',
      folder: 'main_agent',
      added_at: new Date(0).toISOString(),
    };

    await expect(runner(group, 'hello', 'tg:chat', 'tg:chat')).resolves.toBe(
      'error',
    );
    expect(runAgent.mock.calls[0][1].sessionId).toBe('provider-session:ready');
    expect(runAgent.mock.calls[0][1].memoryContextBlock).toContain(
      '<gantry_compaction_delta>',
    );
    expect(markProviderSessionDeltaReplay).not.toHaveBeenCalled();
    expect(
      getAgentTurnContext.mock.calls.some(
        ([input]) => input.promoteReadyProviderSession === true,
      ),
    ).toBe(false);

    await expect(
      runner(group, 'hello again', 'tg:chat', 'tg:chat'),
    ).resolves.toBe('success');
    expect(runAgent.mock.calls[1][1].sessionId).toBe('provider-session:ready');
    expect(markProviderSessionDeltaReplay).toHaveBeenCalledWith({
      providerSessionId: 'provider-session:ready',
      agentSessionId: 'agent-session:main',
      provider: defaultProviderId,
      externalSessionId: 'provider-session:ready',
      status: 'applied',
      compactionBaseCursor: 'cursor:base',
    });
  });

  it('does not report native DeepAgents compaction success without an adapter compaction prompt', async () => {
    const runAgent = vi.fn(async () => ({ status: 'success', result: 'ok' }));
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
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: { id: 'deepagents:langchain' } as never,
        getSelectedAgentHarness: () => 'deepagents',
      },
      ops: () =>
        ({
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent:main_agent',
            agentSessionId: 'agent-session:main',
          })),
        }) as never,
    });

    await expect(
      runner(
        {
          name: 'Main',
          folder: 'main_agent',
          added_at: new Date(0).toISOString(),
          agentConfig: { model: 'gpt-5.5' },
        },
        '',
        'tg:chat',
        'tg:chat',
        undefined,
        {
          maintenanceCompaction: true,
          maintenanceProviderSession: {
            providerSessionId: 'provider-session:locked',
            externalSessionId: 'provider-session:locked',
          },
        },
      ),
    ).resolves.toBe('error');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('renders installed skill metadata without full skill artifacts', () => {
    const block = buildApprovedSkillContextBlockFromSkills([
      {
        id: 'skill:release-writer',
        appId: 'app-one',
        agentId: 'agent-one',
        name: 'release-writer',
        description: 'Use for drafting release notes.',
        source: 'admin_uploaded',
        status: 'installed',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        storage: {
          storageType: 'local-filesystem',
          storageRef: 'skills/release-writer',
          contentHash: 'sha256-frontmatter-revision',
          sizeBytes: 1024,
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);

    expect(block).toContain('[[INSTALLED_SKILLS_AVAILABLE_THIS_SESSION]]');
    expect(block).toContain('release-writer (skill:release-writer)');
    expect(block).toContain('description: Use for drafting release notes.');
    expect(block).toContain('revision: sha256-frontmatter-revision');
    expect(block).toContain('progressive disclosure');
    expect(block).not.toContain('```markdown');
    expect(block).not.toContain('FULL BODY INSTRUCTIONS MUST NOT BE INJECTED');
  });

  it('redacts provider session handles from persisted summaries', () => {
    const summary = summarizeRuntimeResultForPersistence(
      [
        'framed {"newSessionId":"json-new-handle","providerSessionId":"provider-session:json-secret","externalSessionId":"claude-session-json-secret","session_id":"snake-json-handle"}',
        'sessionId=session-inline-handle',
        'latestProviderSessionId latest-whitespace-handle',
        'provider-session:standalone-secret',
        'claude-session-standalone-secret',
      ].join(' '),
    ) as string;

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('json-new-handle');
    expect(summary).not.toContain('provider-session:json-secret');
    expect(summary).not.toContain('claude-session-json-secret');
    expect(summary).not.toContain('snake-json-handle');
    expect(summary).not.toContain('session-inline-handle');
    expect(summary).not.toContain('latest-whitespace-handle');
    expect(summary).not.toContain('provider-session:standalone-secret');
    expect(summary).not.toContain('claude-session-standalone-secret');
  });

  it('caps oversized failed agent run error summaries before persistence', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;
    const errorSummary = `HEAD-START${'x'.repeat(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS + 250,
    )}TAIL-END`;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-1',
      errorSummary,
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary.length).toBeLessThanOrEqual(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS,
    );
    expect(summary).toMatch(/^\[output truncated; showing tail\]\n/);
    expect(summary).not.toContain('HEAD-START');
    expect(summary.endsWith('TAIL-END')).toBe(true);
  });

  it('does not emit marker-only summaries when max chars cannot hold marker and content', () => {
    const accumulator = createRuntimeResultSummaryAccumulator({ maxChars: 0 });
    accumulator.append('important body');

    expect(accumulator.snapshot()).toBeNull();
  });

  it('keeps content instead of marker-only summaries for tiny truncation limits', () => {
    expect(truncateRuntimeResultSummary('important body', 8)).toBe(
      'important body',
    );
    expect(truncateRuntimeResultSummary('important body', 8)).not.toBe(
      '[output truncated; showing tail]',
    );
  });

  it('redacts completion summaries before storing successful runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeSuccessfulRuntimeSessionRun({
      ops,
      group: { name: 'Main', folder: 'main_agent' } as never,
      runId: 'run-2',
      result:
        'ok {"newSessionId":"json-success-handle"} sessionId=session-inline-success provider-session:standalone-success',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.resultSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('json-success-handle');
    expect(summary).not.toContain('session-inline-success');
    expect(summary).not.toContain('provider-session:standalone-success');
  });

  it('redacts provider resume handles before storing failed runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-failed-redaction',
      errorSummary:
        'failed latestProviderSessionId=latest-failed provider-session:standalone-failed {"externalSessionId":"claude-session-failed"}',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('latest-failed');
    expect(summary).not.toContain('provider-session:standalone-failed');
    expect(summary).not.toContain('claude-session-failed');
  });

  it('runs errorSummary through full secret redaction before storing failed runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-failed-secrets',
      errorSummary:
        'gateway rejected token gtw_secret_abc123 and sk-ant-secret-xyz upstream',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('gtw_secret_abc123');
    expect(summary).not.toContain('sk-ant-secret-xyz');
  });

  it('does not throw when failed run bookkeeping cannot be persisted', async () => {
    const completeSessionAgentRun = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await expect(
      completeFailedRuntimeSessionRun({
        ops,
        runId: 'run-failed-bookkeeping',
        errorSummary: 'permission denied',
      }),
    ).resolves.toBeUndefined();

    expect(completeSessionAgentRun).toHaveBeenCalledWith({
      runId: 'run-failed-bookkeeping',
      status: 'failed',
      errorSummary: 'permission denied',
    });
  });

  it('does not throw when successful run bookkeeping cannot be persisted', async () => {
    const completeSessionAgentRun = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await expect(
      completeSuccessfulRuntimeSessionRun({
        ops,
        group: { name: 'Main', folder: 'main_agent' } as never,
        runId: 'run-success-bookkeeping',
        result: 'done',
      }),
    ).resolves.toBeUndefined();

    expect(completeSessionAgentRun).toHaveBeenCalledWith({
      runId: 'run-success-bookkeeping',
      status: 'completed',
      resultSummary: 'done',
    });
  });

  it('does not persist provider resume handles under the job-owned session scope', async () => {
    const setSession = vi.fn().mockResolvedValue(true);
    const ops = {
      setSession,
    } as unknown as RuntimeAgentSessionRepository;

    await completeSuccessfulRuntimeSessionRun({
      ops,
      group: { name: 'Scheduler', folder: 'scheduler_agent' } as never,
      chatJid: 'tg:scheduler',
      threadId: 'topic-1',
      conversationKind: 'channel',
      jobId: 'job-1',
      agentSessionId: 'agent-session:job-1',
      providerSessionId: 'claude-session-job-1',
      result: 'ok',
    });

    expect(setSession).not.toHaveBeenCalled();
  });
});
