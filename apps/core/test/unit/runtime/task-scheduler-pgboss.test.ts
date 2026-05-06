import { describe, expect, it, vi } from 'vitest';

import type { Job } from '@core/domain/types.js';
import { PgBossSchedulerEngine } from '@core/infrastructure/pgboss/scheduler-engine.js';

function createJob(overrides: Partial<Job> = {}): Job {
  const now = '2026-04-24T08:00:00.000Z';
  return {
    id: 'job-1',
    name: 'Daily check',
    prompt: 'Check status',
    model: null,
    script: null,
    schedule_type: 'once',
    schedule_value: '2026-04-24T09:00:00.000Z',
    status: 'active',
    linked_sessions: [],
    session_id: null,
    thread_id: null,
    group_scope: 'tg:team',
    created_by: 'agent',
    created_at: now,
    updated_at: now,
    next_run: '2026-04-24T09:00:00.000Z',
    last_run: null,
    silent: false,
    cleanup_after_ms: 86_400_000,
    timeout_ms: 300_000,
    max_retries: 3,
    retry_backoff_ms: 5_000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    execution_mode: 'parallel',
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

describe('PgBossSchedulerEngine', () => {
  it('re-enqueues stale pending once jobs immediately and throttles repeated syncs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T09:10:10.000Z'));
    try {
      const staleJob = createJob({
        next_run: '2026-04-24T09:00:00.000Z',
        schedule_value: '2026-04-24T09:00:00.000Z',
        last_run: null,
      });
      const send = vi.fn().mockResolvedValue(undefined);
      const boss = {
        send,
        schedule: vi.fn().mockResolvedValue(undefined),
        unschedule: vi.fn().mockResolvedValue(undefined),
        deleteJob: vi.fn().mockResolvedValue(undefined),
      };
      const engine = new PgBossSchedulerEngine(
        {
          registeredGroups: () => ({}),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage: vi.fn(),
          opsRepository: {
            releaseStaleJobLeases: vi.fn().mockResolvedValue(0),
            getAllJobs: vi.fn().mockResolvedValue([staleJob]),
          } as never,
        },
        {
          registerSystemJobs: vi.fn().mockResolvedValue(undefined),
          runJob: vi.fn().mockResolvedValue(undefined),
          sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
        },
      );
      (engine as unknown as { boss: typeof boss }).boss = boss;

      await (
        engine as unknown as { syncAllJobs: () => Promise<void> }
      ).syncAllJobs();
      await (
        engine as unknown as { syncAllJobs: () => Promise<void> }
      ).syncAllJobs();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenLastCalledWith(
        'myclaw.jobs.parallel',
        { jobId: 'job-1', scheduledFor: '2026-04-24T09:00:00.000Z' },
        expect.objectContaining({
          id: 'myclaw.send.am9iLTE6b25jZQ',
          startAfter: '2026-04-24T09:10:10.000Z',
          group: { id: 'myclaw.group.dGc6dGVhbQ' },
        }),
      );

      vi.setSystemTime(new Date('2026-04-24T09:11:10.000Z'));
      await (
        engine as unknown as { syncAllJobs: () => Promise<void> }
      ).syncAllJobs();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(
        'myclaw.jobs.parallel',
        { jobId: 'job-1', scheduledFor: '2026-04-24T09:00:00.000Z' },
        expect.objectContaining({
          startAfter: '2026-04-24T09:11:10.000Z',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-enqueues active jobs after stale lease release even when the schedule signature is unchanged', async () => {
    const activeJob = createJob();
    const send = vi.fn().mockResolvedValue(undefined);
    const boss = {
      send,
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const opsRepository = {
      releaseStaleJobLeases: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1),
      getAllJobs: vi.fn().mockResolvedValue([activeJob]),
    };
    const onSchedulerChanged = vi.fn();
    const engine = new PgBossSchedulerEngine(
      {
        registeredGroups: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: opsRepository as never,
        onSchedulerChanged,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    (engine as unknown as { boss: typeof boss }).boss = boss;

    await (
      engine as unknown as { syncAllJobs: () => Promise<void> }
    ).syncAllJobs();
    await (
      engine as unknown as { syncAllJobs: () => Promise<void> }
    ).syncAllJobs();

    expect(send).toHaveBeenCalledTimes(2);
    expect(onSchedulerChanged).toHaveBeenCalledWith();
  });

  it('schedules cron jobs with pg-boss using serialized queue affinity', async () => {
    const cronJob = createJob({
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      execution_mode: 'serialized',
      next_run: '2026-04-25T09:00:00.000Z',
      group_scope: 'sl:team',
    });
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new PgBossSchedulerEngine(
      {
        registeredGroups: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue(0),
          getAllJobs: vi.fn().mockResolvedValue([cronJob]),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    (engine as unknown as { boss: typeof boss }).boss = boss;

    await (
      engine as unknown as { syncAllJobs: () => Promise<void> }
    ).syncAllJobs();

    expect(boss.schedule).toHaveBeenCalledWith(
      'myclaw.jobs.serialized',
      '0 9 * * *',
      { jobId: 'job-1' },
      expect.objectContaining({
        key: 'myclaw.job.am9iLTE',
        group: { id: 'myclaw.group.c2w6dGVhbQ' },
        singletonKey: 'myclaw.job.am9iLTE',
        retryLimit: 0,
      }),
    );
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('does not enqueue manual or paused jobs during schedule sync', async () => {
    const manualJob = createJob({
      id: 'manual-job',
      schedule_type: 'manual',
      schedule_value: 'manual',
      next_run: null,
    });
    const pausedJob = createJob({
      id: 'paused-job',
      status: 'paused',
      next_run: '2026-04-25T09:00:00.000Z',
    });
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new PgBossSchedulerEngine(
      {
        registeredGroups: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue(0),
          getAllJobs: vi.fn().mockResolvedValue([manualJob, pausedJob]),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    (engine as unknown as { boss: typeof boss }).boss = boss;

    await (
      engine as unknown as { syncAllJobs: () => Promise<void> }
    ).syncAllJobs();

    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it('dispatches serialized jobs through a group-scoped queue key and releases the slot', async () => {
    const job = createJob({
      execution_mode: 'serialized',
      group_scope: 'tg:team',
    });
    const callbacks = {
      registerSystemJobs: vi.fn().mockResolvedValue(undefined),
      runJob: vi.fn().mockResolvedValue(undefined),
      sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
    };
    const engine = new PgBossSchedulerEngine(
      {
        registeredGroups: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      callbacks,
    );
    const requestSync = vi
      .spyOn(engine, 'requestSync')
      .mockImplementation(() => undefined);

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{
            data: { jobId: string; triggerId?: string; runId?: string };
          }>,
          mode: 'serialized',
        ) => Promise<void>;
      }
    ).processBossJobs(
      [{ data: { jobId: 'job-1', triggerId: 'trigger-1', runId: 'run-1' } }],
      'serialized',
    );

    expect(callbacks.runJob).toHaveBeenCalledWith(
      job,
      expect.any(Object),
      '__scheduler__:tg:team',
      'serialized',
      { jobId: 'job-1', triggerId: 'trigger-1', runId: 'run-1' },
    );
    expect(requestSync).toHaveBeenCalledWith();
  });
});
