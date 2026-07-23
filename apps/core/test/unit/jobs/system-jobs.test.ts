import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, ConversationRoute } from '@core/domain/types.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'system:dreaming:agent',
    name: 'Memory Dreaming',
    prompt: '__system:memory_dream',
    schedule_type: 'cron',
    schedule_value: '* * * * *',
    status: 'active',
    session_id: null,
    workspace_key: 'agent',
    created_by: 'agent',
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 0,
    timeout_ms: 300_000,
    max_retries: 1,
    retry_backoff_ms: 30_000,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  } as Job;
}

function makeRoute(
  overrides: Partial<ConversationRoute> = {},
): ConversationRoute {
  return {
    name: 'Route',
    folder: 'agent',
    trigger: 'Agent',
    added_at: '2026-05-08T00:00:00.000Z',
    conversationKind: 'channel',
    ...overrides,
  };
}

async function loadSystemJobs(
  triggerDreaming = vi.fn(),
  listPendingReviews = vi.fn(async () => []),
  configOverrides: Record<string, unknown> = {},
  runBrainDreamBatch = vi.fn(async () => ({
    runId: 'brain-1',
    pages: 0,
    applied: 0,
    noop: 0,
    rejected: 0,
    proposed: 0,
  })),
) {
  vi.resetModules();
  vi.doMock('@core/config/index.js', () => ({
    MEMORY_DREAMING_CRON: '* * * * *',
    MEMORY_MAINTENANCE_MAX_PENDING: 5_000,
    RUNTIME_MEMORY_DREAMING_ENABLED: true,
    RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED: false,
    getRuntimeSettingsForConfig: vi.fn(() => ({
      observer: { enabled: false },
    })),
    TIMEZONE: 'UTC',
    MEMORY_BACKFILL_ENABLED: false,
    MEMORY_BACKFILL_CRON: '45 3 * * *',
    MEMORY_BACKFILL_MAX_ITEMS_PER_RUN: 500,
    MEMORY_BACKFILL_MODE: 'auto',
    MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS: 100,
    MEMORY_EMBED_PROVIDER: 'disabled',
    MEMORY_EMBED_MODEL: 'text-embedding-3-small',
    MEMORY_EMBED_DIMENSIONS: 1536,
    MEMORY_EMBED_BATCH_SIZE: 16,
    OPENAI_DAILY_EMBED_LIMIT: 500,
    ...configOverrides,
  }));
  vi.doMock('@core/memory/app-memory-service.js', () => ({
    AppMemoryService: {
      getInstance: () => ({ triggerDreaming, listPendingReviews }),
    },
  }));
  vi.doMock('@core/brain/brain-runtime.js', () => ({
    createRuntimeBrainService: vi.fn(() => ({})),
    runRuntimeBrainDreamBatch: runBrainDreamBatch,
  }));
  return import('@core/jobs/system-jobs.js');
}

describe('system memory dreaming jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers scheduled dreaming per concrete bound conversation', async () => {
    const { registerSystemJobs } = await loadSystemJobs();
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn().mockResolvedValue(undefined);
    const getAllJobs = vi.fn(async () => []);
    const deleteJob = vi.fn(async () => undefined);
    const routes = {
      'sl:C123': makeRoute({ folder: 'agent-a', conversationKind: 'channel' }),
      'sl:D123': makeRoute({ folder: 'agent-a', conversationKind: 'dm' }),
    };

    await registerSystemJobs({
      conversationRoutes: () => routes,
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never);

    expect(upsertJob).toHaveBeenCalledTimes(3);
    expect(
      upsertJob.mock.calls.map((call) => call[0].execution_context),
    ).toEqual([
      {
        conversationJid: 'sl:C123',
        threadId: null,
        workspaceKey: 'agent-a',
        sessionId: null,
      },
      {
        conversationJid: 'sl:D123',
        threadId: null,
        workspaceKey: 'agent-a',
        sessionId: null,
      },
      {
        conversationJid: 'sl:C123',
        threadId: null,
        workspaceKey: 'agent-a',
        sessionId: null,
      },
    ]);
    expect(
      upsertJob.mock.calls.map((call) => call[0].notification_routes),
    ).toEqual([
      [
        {
          conversationJid: 'sl:C123',
          threadId: null,
          label: 'primary',
        },
      ],
      [
        {
          conversationJid: 'sl:D123',
          threadId: null,
          label: 'primary',
        },
      ],
      [
        {
          conversationJid: 'sl:C123',
          threadId: null,
          label: 'primary',
        },
      ],
    ]);
    expect(upsertJob.mock.calls.map((call) => call[0].workspace_key)).toEqual([
      'agent-a',
      'agent-a',
      'agent-a',
    ]);
    expect(upsertJob.mock.calls.map((call) => call[0].timeout_ms)).toEqual([
      1_260_000, 1_260_000, 600_000,
    ]);
    expect(upsertJob.mock.calls.map((call) => call[0].silent)).toEqual([
      true,
      true,
      true,
    ]);
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it('re-stamps silent on dead-lettered dreaming jobs without reviving them', async () => {
    const { registerSystemJobs } = await loadSystemJobs();
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const updateJob = vi.fn(async () => undefined);
    const getJobById = vi.fn(async (id: string) =>
      id.startsWith('system:dreaming:')
        ? makeJob({ id, status: 'dead_lettered', silent: false })
        : undefined,
    );
    const getAllJobs = vi.fn(async () => []);
    const deleteJob = vi.fn(async () => undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
        updateJob,
      },
    } as never);

    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob).toHaveBeenCalledWith(
      expect.stringMatching(/^system:dreaming:/),
      { silent: true },
    );
    expect(
      upsertJob.mock.calls.filter(
        (call) => call[0].prompt === '__system:memory_dream',
      ),
    ).toHaveLength(0);
  });

  it('registers per-conversation dreaming jobs non-silent when dreaming alerts are enabled', async () => {
    const { registerSystemJobs } = await loadSystemJobs(vi.fn(), vi.fn(), {
      RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED: true,
    });
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn().mockResolvedValue(undefined);
    const getAllJobs = vi.fn(async () => []);
    const deleteJob = vi.fn(async () => undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never);

    expect(
      upsertJob.mock.calls.map((call) => [call[0].prompt, call[0].silent]),
    ).toEqual([
      ['__system:memory_dream', false],
      ['__system:brain_dream', true],
    ]);
  });

  it('deletes obsolete dreaming jobs when conversations are removed', async () => {
    const { registerSystemJobs } = await loadSystemJobs();
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn().mockResolvedValue(undefined);
    const getAllJobs = vi.fn(async () => [
      makeJob({
        id: 'system:dreaming:agent:stale',
        name: 'Memory Dreaming (agent sl:COLD)',
      }),
      makeJob({
        id: 'manual:job',
        name: 'Manual job',
      }),
    ]);
    const deleteJob = vi.fn(async () => undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never);

    expect(deleteJob).toHaveBeenCalledWith('system:dreaming:agent:stale');
    expect(deleteJob).not.toHaveBeenCalledWith('manual:job');
    expect(upsertJob).toHaveBeenCalledTimes(2);
  });

  it('keeps obsolete dreaming jobs while a run lease is unsettled', async () => {
    const { registerSystemJobs } = await loadSystemJobs();
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn().mockResolvedValue(undefined);
    const getAllJobs = vi.fn(async () => [
      makeJob({
        id: 'system:dreaming:agent:leased',
        name: 'Memory Dreaming (agent sl:COLD)',
        lease_run_id: 'run-active',
        lease_expires_at: '2026-05-08T00:05:00.000Z',
      }),
    ]);
    const deleteJob = vi.fn(async () => undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never);

    expect(deleteJob).not.toHaveBeenCalled();
    expect(upsertJob).toHaveBeenCalledTimes(2);
  });

  it('deletes brain singleton jobs once their enabling condition goes away', async () => {
    const { registerSystemJobs } = await loadSystemJobs(vi.fn(), vi.fn(), {
      RUNTIME_MEMORY_DREAMING_ENABLED: false,
    });
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn(async (id: string) =>
      id === 'system:brain-dreaming'
        ? makeJob({ id: 'system:brain-dreaming', name: 'Brain Dreaming' })
        : undefined,
    );
    const getAllJobs = vi.fn(async () => []);
    const deleteJob = vi.fn(async () => undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never);

    expect(deleteJob).toHaveBeenCalledWith('system:brain-dreaming');
    expect(upsertJob).not.toHaveBeenCalled();
  });

  it('keeps brain singleton jobs with unsettled leases when disabled', async () => {
    const { registerSystemJobs } = await loadSystemJobs(vi.fn(), vi.fn(), {
      RUNTIME_MEMORY_DREAMING_ENABLED: false,
    });
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn(async (id: string) =>
      id === 'system:brain-dreaming'
        ? makeJob({
            id: 'system:brain-dreaming',
            name: 'Brain Dreaming',
            lease_run_id: 'run-active',
            lease_expires_at: '2026-05-08T00:05:00.000Z',
          })
        : undefined,
    );
    const getAllJobs = vi.fn(async () => []);
    const deleteJob = vi.fn(async () => undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never);

    expect(deleteJob).not.toHaveBeenCalled();
  });

  it('cleans up a lease-protected singleton on a later pass despite the cached signature', async () => {
    const { registerSystemJobs } = await loadSystemJobs(vi.fn(), vi.fn(), {
      RUNTIME_MEMORY_DREAMING_ENABLED: false,
    });
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    let leaseSettled = false;
    const getJobById = vi.fn(async (id: string) =>
      id === 'system:brain-dreaming'
        ? makeJob({
            id: 'system:brain-dreaming',
            name: 'Brain Dreaming',
            ...(leaseSettled
              ? {}
              : {
                  lease_run_id: 'run-active',
                  lease_expires_at: '2026-05-08T00:05:00.000Z',
                }),
          })
        : undefined,
    );
    const getAllJobs = vi.fn(async () => []);
    const deleteJob = vi.fn(async () => undefined);
    const deps = {
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs,
        deleteJob,
        upsertJob,
      },
    } as never;

    await registerSystemJobs(deps);
    expect(deleteJob).not.toHaveBeenCalled();

    leaseSettled = true;
    await registerSystemJobs(deps);
    expect(deleteJob).toHaveBeenCalledWith('system:brain-dreaming');
  });

  it('registers memory and brain embedding backfill jobs together', async () => {
    const { registerSystemJobs } = await loadSystemJobs(vi.fn(), vi.fn(), {
      MEMORY_BACKFILL_ENABLED: true,
      MEMORY_EMBED_PROVIDER: 'test',
    });
    const upsertJob = vi.fn().mockResolvedValue({ created: true });
    const getJobById = vi.fn().mockResolvedValue(undefined);

    await registerSystemJobs({
      conversationRoutes: () => ({
        'sl:C123': makeRoute({ folder: 'agent', conversationKind: 'channel' }),
      }),
      opsRepository: {
        getJobById,
        getAllJobs: vi.fn(async () => []),
        deleteJob: vi.fn(async () => undefined),
        upsertJob,
      },
    } as never);

    expect(upsertJob.mock.calls.map((call) => call[0].id)).toEqual([
      expect.stringMatching(/^system:dreaming:/),
      'system:brain-dreaming',
      'system:embedding-backfill',
      'system:brain-embedding-backfill',
    ]);
  });

  it('runs scheduled channel dreaming against whole channel subject without thread memory scope', async () => {
    const triggerDreaming = vi.fn().mockResolvedValue({ runId: 'dream-1' });
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming);
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait: vi.fn(async (_group, task) => {
        await task();
        return { queued: true, deduped: false, reason: 'queued' };
      }),
      getPendingCount: vi.fn(() => 0),
    });

    const result = await handleSystemJob(makeJob(), {
      folder: 'agent-a',
      conversationId: 'sl:C123',
      conversationKind: 'channel',
      threadId: 'thread-1',
    });

    expect(triggerDreaming).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:agent-a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
        channelId: 'conversation:sl:C123',
        phase: 'all',
        timeoutMs: expect.any(Number),
      }),
    );
    expect(triggerDreaming.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(triggerDreaming.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(
      240_000,
    );
    expect(triggerDreaming.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(
      200_000,
    );
    expect(result).toBe('Memory dreaming completed.');
  });

  it('propagates scheduler deadlines through the maintenance queue and dreaming service', async () => {
    const triggerDreaming = vi.fn().mockResolvedValue({ runId: 'dream-1' });
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming);
    const enqueueAndWait = vi.fn(async (_group, task, _dedupeKey, options) => {
      expect(options.signal).toEqual(expect.any(AbortSignal));
      await task();
      return { queued: true, deduped: false, reason: 'queued' };
    });
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait,
      getPendingCount: vi.fn(() => 0),
    });
    const parentController = new AbortController();
    const deadlineAtMs = Date.now() + 90_000;

    await handleSystemJob(
      makeJob({ timeout_ms: 150_000 }),
      {
        folder: 'agent-a',
        conversationId: 'sl:C123',
        conversationKind: 'channel',
      },
      { signal: parentController.signal, deadlineAtMs },
    );

    expect(triggerDreaming).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
        deadlineAtMs,
      }),
    );
    expect(triggerDreaming.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(
      90_000,
    );
  });

  it('reports only actionable memory dreaming issues', async () => {
    const triggerDreaming = vi.fn().mockResolvedValue({
      runId: 'dream-1',
      status: 'completed',
      summary: {
        promoted: 2,
        updated: 1,
        needsReview: 3,
        skipped: 4,
        blocked: 5,
      },
    });
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming);
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait: vi.fn(async (_group, task) => {
        await task();
        return { queued: true, deduped: false, reason: 'queued' };
      }),
      getPendingCount: vi.fn(() => 0),
    });

    const result = await handleSystemJob(makeJob(), {
      folder: 'agent-a',
      conversationId: 'sl:C123',
      conversationKind: 'channel',
    });

    expect(result).toBe(
      'Memory dreaming needs attention: 3 sent to review, 5 blocked.',
    );
  });

  it('does not include memory change counts when no action is needed', async () => {
    const triggerDreaming = vi.fn().mockResolvedValue({
      runId: 'dream-1',
      status: 'completed',
      summary: {
        promoted: 2,
        updated: 1,
        needsReview: 0,
        pendingReviews: 0,
        skipped: 4,
        blocked: 0,
      },
    });
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming);
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait: vi.fn(async (_group, task) => {
        await task();
        return { queued: true, deduped: false, reason: 'queued' };
      }),
      getPendingCount: vi.fn(() => 0),
    });

    const result = await handleSystemJob(makeJob(), {
      folder: 'agent-a',
      conversationId: 'sl:C123',
      conversationKind: 'channel',
    });

    expect(result).toBe('Memory dreaming completed.');
  });

  it('surfaces existing pending memory reviews even when the run has no new changes', async () => {
    const triggerDreaming = vi.fn().mockResolvedValue({
      runId: 'dream-1',
      status: 'completed',
      summary: {
        promoted: 0,
        updated: 0,
        needsReview: 0,
        pendingReviews: 7,
        skipped: 0,
        blocked: 0,
      },
    });
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming);
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait: vi.fn(async (_group, task) => {
        await task();
        return { queued: true, deduped: false, reason: 'queued' };
      }),
      getPendingCount: vi.fn(() => 0),
    });

    const result = await handleSystemJob(makeJob(), {
      folder: 'agent-a',
      conversationId: 'sl:C123',
      conversationKind: 'channel',
    });

    expect(result).toBe(
      'Memory dreaming needs attention: 7 pending memory reviews need review.',
    );
  });

  it('adds pending review context when dreaming fails after review creation', async () => {
    const triggerDreaming = vi
      .fn()
      .mockRejectedValue(new Error('memory dreaming deadline exceeded'));
    const listPendingReviews = vi.fn(async () => [
      { id: 'mrv-1' },
      { id: 'mrv-2' },
    ]);
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming, listPendingReviews);
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait: vi.fn(async (_group, task) => {
        await task();
        return { queued: true, deduped: false, reason: 'queued' };
      }),
      getPendingCount: vi.fn(() => 0),
    });

    await expect(
      handleSystemJob(makeJob(), {
        folder: 'agent-a',
        conversationId: 'sl:C123',
        conversationKind: 'channel',
      }),
    ).rejects.toThrow(
      'memory dreaming deadline exceeded. 2 pending memory reviews need review.',
    );
    expect(listPendingReviews).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:agent-a',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
      }),
      { statementTimeoutMs: 2_000 },
    );
  });

  it('keeps the scheduled brain receipt exact while observer is off', async () => {
    const runBrainDreamBatch = vi.fn(async () => ({
      runId: 'brain-1',
      pages: 2,
      applied: 1,
      noop: 2,
      rejected: 3,
      proposed: 4,
    }));
    const { handleSystemJob } = await loadSystemJobs(
      undefined,
      undefined,
      {},
      runBrainDreamBatch,
    );

    await expect(
      handleSystemJob(
        makeJob({
          id: 'system:brain-dreaming',
          name: 'Brain Dreaming',
          prompt: '__system:brain_dream',
        }),
        { folder: 'agent' },
      ),
    ).resolves.toBe(
      'Brain dreaming complete: 2 page(s), 1 applied, 2 no-op, 3 rejected, 4 proposed.',
    );
    expect(runBrainDreamBatch).toHaveBeenCalledWith({
      appId: 'default',
      signal: undefined,
      observerEnabled: false,
      observerOwnerRecipient: null,
    });
  });

  it('keeps ordinary brain dreaming active when observer owner configuration is missing', async () => {
    const runBrainDreamBatch = vi.fn(async () => ({
      runId: 'brain-1',
      pages: 0,
      applied: 0,
      noop: 0,
      rejected: 0,
      proposed: 0,
    }));
    const { handleSystemJob } = await loadSystemJobs(
      undefined,
      undefined,
      {
        getRuntimeSettingsForConfig: vi.fn(() => ({
          observer: { enabled: true },
        })),
      },
      runBrainDreamBatch,
    );

    await expect(
      handleSystemJob(
        makeJob({
          id: 'system:brain-dreaming',
          name: 'Brain Dreaming',
          prompt: '__system:brain_dream',
        }),
        { folder: 'agent' },
      ),
    ).resolves.toBe(
      'Brain dreaming complete: 0 page(s), 0 applied, 0 no-op, 0 rejected, 0 proposed.',
    );
    expect(runBrainDreamBatch).toHaveBeenCalledWith({
      appId: 'default',
      signal: undefined,
      observerEnabled: false,
      observerOwnerRecipient: null,
    });
  });

  it('appends the observer emission receipt only while observer is enabled', async () => {
    const runBrainDreamBatch = vi.fn(async () => ({
      runId: 'brain-1',
      pages: 1,
      applied: 0,
      noop: 0,
      rejected: 0,
      proposed: 0,
      observer: {
        persisted: 1,
        deduplicated: 0,
        filtered: 0,
        message:
          'Insight emission complete: 1 persisted, 0 deduplicated, 0 filtered.',
      },
    }));
    const { handleSystemJob } = await loadSystemJobs(
      undefined,
      undefined,
      {
        getRuntimeSettingsForConfig: vi.fn(() => ({
          observer: {
            enabled: true,
            owner: { recipient: 'owner-1', conversation: 'owner-dm' },
          },
        })),
      },
      runBrainDreamBatch,
    );

    await expect(
      handleSystemJob(
        makeJob({
          id: 'system:brain-dreaming',
          name: 'Brain Dreaming',
          prompt: '__system:brain_dream',
        }),
        { folder: 'agent' },
      ),
    ).resolves.toBe(
      'Brain dreaming complete: 1 page(s), 0 applied, 0 no-op, 0 rejected, 0 proposed. Insight emission complete: 1 persisted, 0 deduplicated, 0 filtered.',
    );
    expect(runBrainDreamBatch).toHaveBeenCalledWith({
      appId: 'default',
      signal: undefined,
      observerEnabled: true,
      observerOwnerRecipient: 'owner-1',
    });
  });

  it('reads observer settings for each scheduled run without reimporting', async () => {
    let observer: {
      enabled: boolean;
      owner?: { recipient: string; conversation: string };
    } = { enabled: false };
    const getRuntimeSettingsForConfig = vi.fn(() => ({ observer }));
    const runBrainDreamBatch = vi.fn(async () => ({
      runId: 'brain-1',
      pages: 0,
      applied: 0,
      noop: 0,
      rejected: 0,
      proposed: 0,
      observer: {
        persisted: 0,
        deduplicated: 0,
        filtered: 0,
        message:
          'Insight emission complete: 0 persisted, 0 deduplicated, 0 filtered.',
      },
    }));
    const { handleSystemJob } = await loadSystemJobs(
      undefined,
      undefined,
      { getRuntimeSettingsForConfig },
      runBrainDreamBatch,
    );
    const job = makeJob({
      id: 'system:brain-dreaming',
      name: 'Brain Dreaming',
      prompt: '__system:brain_dream',
    });

    await expect(handleSystemJob(job, { folder: 'agent' })).resolves.toBe(
      'Brain dreaming complete: 0 page(s), 0 applied, 0 no-op, 0 rejected, 0 proposed.',
    );

    observer = {
      enabled: true,
      owner: { recipient: 'owner-2', conversation: 'owner-dm' },
    };
    await expect(handleSystemJob(job, { folder: 'agent' })).resolves.toBe(
      'Brain dreaming complete: 0 page(s), 0 applied, 0 no-op, 0 rejected, 0 proposed. Insight emission complete: 0 persisted, 0 deduplicated, 0 filtered.',
    );

    expect(getRuntimeSettingsForConfig).toHaveBeenCalledTimes(2);
    expect(runBrainDreamBatch.mock.calls).toEqual([
      [
        {
          appId: 'default',
          signal: undefined,
          observerEnabled: false,
          observerOwnerRecipient: null,
        },
      ],
      [
        {
          appId: 'default',
          signal: undefined,
          observerEnabled: true,
          observerOwnerRecipient: 'owner-2',
        },
      ],
    ]);
  });

  it('runs scheduled DM dreaming against user subject without thread scope', async () => {
    const triggerDreaming = vi.fn().mockResolvedValue({ runId: 'dream-1' });
    const { _setMemoryMaintenanceQueueForTests, handleSystemJob } =
      await loadSystemJobs(triggerDreaming);
    _setMemoryMaintenanceQueueForTests({
      enqueueAndWait: vi.fn(async (_group, task) => {
        await task();
        return { queued: true, deduped: false, reason: 'queued' };
      }),
      getPendingCount: vi.fn(() => 0),
    });

    await handleSystemJob(makeJob(), {
      folder: 'agent-a',
      conversationId: 'sl:D123',
      conversationKind: 'dm',
      userId: 'sl:U123',
      threadId: 'ignored-thread',
    });

    expect(triggerDreaming).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:agent-a',
        subjectType: 'user',
        subjectId: 'sl:U123',
        userId: 'sl:U123',
        phase: 'all',
      }),
    );
    expect(triggerDreaming.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
    expect(triggerDreaming.mock.calls[0]?.[0]).not.toHaveProperty('channelId');
  });
});
