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
) {
  vi.resetModules();
  vi.doMock('@core/config/index.js', () => ({
    MEMORY_DREAMING_CRON: '* * * * *',
    MEMORY_MAINTENANCE_MAX_PENDING: 5_000,
    RUNTIME_MEMORY_DREAMING_ENABLED: true,
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
  }));
  vi.doMock('@core/memory/app-memory-service.js', () => ({
    AppMemoryService: {
      getInstance: () => ({ triggerDreaming, listPendingReviews }),
    },
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

    expect(upsertJob).toHaveBeenCalledTimes(2);
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
    ]);
    expect(upsertJob.mock.calls.map((call) => call[0].workspace_key)).toEqual([
      'agent-a',
      'agent-a',
    ]);
    expect(upsertJob.mock.calls.map((call) => call[0].timeout_ms)).toEqual([
      1_260_000, 1_260_000,
    ]);
    expect(deleteJob).not.toHaveBeenCalled();
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
    expect(result).toBe('Memory dreaming completed with no memory changes.');
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

  it('returns a user-facing dreaming outcome summary', async () => {
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
      'Memory dreaming completed: 2 promoted, 1 updated, 3 sent to review.',
    );
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
      'Memory dreaming completed with no memory changes. 7 pending memory reviews need review.',
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
