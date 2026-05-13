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
    group_scope: 'agent',
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

async function loadSystemJobs(triggerDreaming = vi.fn()) {
  vi.resetModules();
  vi.doMock('@core/config/index.js', () => ({
    MEMORY_DREAMING_CRON: '* * * * *',
    MEMORY_MAINTENANCE_MAX_PENDING: 5_000,
    RUNTIME_MEMORY_DREAMING_ENABLED: true,
    TIMEZONE: 'UTC',
  }));
  vi.doMock('@core/memory/app-memory-service.js', () => ({
    AppMemoryService: {
      getInstance: () => ({ triggerDreaming }),
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
        groupScope: 'agent-a',
        sessionId: null,
      },
      {
        conversationJid: 'sl:D123',
        threadId: null,
        groupScope: 'agent-a',
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
    expect(upsertJob.mock.calls.map((call) => call[0].group_scope)).toEqual([
      'agent-a',
      'agent-a',
    ]);
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it('runs scheduled channel dreaming against channel subject with thread scope', async () => {
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
        threadId: 'thread-1',
        phase: 'all',
      }),
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
