import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeStore = vi.hoisted(() => ({
  controlRepository: {
    getTriggerById: vi.fn(),
  },
}));
const workerCoordination = vi.hoisted(() => ({
  markStaleWorkersUnhealthy: vi.fn(async () => [] as string[]),
  recoverExpiredRunLeases: vi.fn(async () => [] as unknown[]),
  releaseRunSlotsForStaleWorkers: vi.fn(async () => 0),
  getWorker: vi.fn(async () => ({
    capabilities: [] as string[],
  })),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => runtimeStore.controlRepository,
  getRuntimeStorage: () => ({
    repositories: {
      runtimeDependencies: {
        listRuntimeDependencies: async () => [],
      },
    },
  }),
  getWorkerCoordinationRepository: () => workerCoordination,
}));

const deploymentModeMock = vi.hoisted(() => ({
  mode: 'workstation' as 'workstation' | 'fleet',
}));
const runtimeQueueConfigMock = vi.hoisted(() => ({
  value: undefined as
    | { maxMessageRuns: number; maxJobRuns: number; maxRetries: number }
    | undefined,
}));

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/config/index.js')>();
  return {
    ...actual,
    getDeploymentMode: () => deploymentModeMock.mode,
    getRuntimeQueueConfig: () =>
      runtimeQueueConfigMock.value ?? actual.getRuntimeQueueConfig(),
  };
});

vi.mock('@core/jobs/worker-identity.js', () => ({
  currentWorkerInstanceId: () => 'worker-test',
}));

import type { Job } from '@core/domain/types.js';
import {
  PgBossSchedulerEngine,
  SCHEDULER_MAINTENANCE_SYNC_INTERVAL_MS,
} from '@core/infrastructure/pgboss/scheduler-engine.js';
import { configureRunSlotBackend } from '@core/jobs/concurrency.js';
import { JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT } from '@core/shared/scheduler-copy.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import { WORKER_STALE_AFTER_MS } from '@core/shared/worker-heartbeat.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createJob(overrides: Partial<Job> = {}): Job {
  const now = '2026-04-24T08:00:00.000Z';
  return {
    id: 'job-1',
    name: 'Daily check',
    prompt: 'Check status',
    model: null,
    schedule_type: 'once',
    schedule_value: '2026-04-24T09:00:00.000Z',
    status: 'active',
    session_id: null,
    thread_id: null,
    workspace_key: 'tg:team',
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
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

describe('PgBossSchedulerEngine', () => {
  afterEach(() => {
    deploymentModeMock.mode = 'workstation';
    runtimeQueueConfigMock.value = undefined;
    workerCoordination.markStaleWorkersUnhealthy.mockResolvedValue([]);
    workerCoordination.recoverExpiredRunLeases.mockResolvedValue([]);
    workerCoordination.releaseRunSlotsForStaleWorkers.mockResolvedValue(0);
    workerCoordination.getWorker.mockResolvedValue({ capabilities: [] });
    vi.clearAllMocks();
    configureRunSlotBackend(null);
  });

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
          conversationRoutes: () => ({}),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage: vi.fn(),
          opsRepository: {
            releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
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
        'gantry.jobs',
        { jobId: 'job-1', scheduledFor: '2026-04-24T09:00:00.000Z' },
        expect.objectContaining({
          id: expect.stringMatching(UUID_PATTERN),
          startAfter: new Date('2026-04-24T09:10:10.000Z'),
          group: { id: 'gantry.group.dGc6dGVhbQ' },
        }),
      );

      vi.setSystemTime(new Date('2026-04-24T09:11:10.000Z'));
      await (
        engine as unknown as { syncAllJobs: () => Promise<void> }
      ).syncAllJobs();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(
        'gantry.jobs',
        { jobId: 'job-1', scheduledFor: '2026-04-24T09:00:00.000Z' },
        expect.objectContaining({
          id: send.mock.calls[0][2].id,
          startAfter: new Date('2026-04-24T09:11:10.000Z'),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes persisted Postgres timestamps to pg-boss as dates', async () => {
    const job = createJob({
      schedule_value: '2027-05-19T09:30:00+05:30',
      next_run: '2027-05-19 04:00:00+00',
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
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
          getAllJobs: vi.fn().mockResolvedValue([job]),
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

    expect(send).toHaveBeenCalledWith(
      'gantry.jobs',
      { jobId: 'job-1', scheduledFor: '2027-05-19 04:00:00+00' },
      expect.objectContaining({
        startAfter: new Date('2027-05-19T04:00:00.000Z'),
        priority: 0,
      }),
    );
  });

  it('assigns lower pg-boss priority to trusted system maintenance jobs', async () => {
    const job = createJob({
      id: 'system:dreaming:team:abc123',
      prompt: '__system:memory_dream',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      next_run: '2027-05-19T04:00:00.000Z',
    });
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule,
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
          getAllJobs: vi.fn().mockResolvedValue([job]),
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

    expect(schedule).toHaveBeenCalledWith(
      'gantry.jobs',
      '* * * * *',
      { jobId: 'system:dreaming:team:abc123' },
      expect.objectContaining({
        priority: -1,
      }),
    );
  });

  it('rehydrates pending recovery turns during full scheduler sync', async () => {
    const job = createJob({
      status: 'paused',
      next_run: null,
      pause_reason: 'Setup required',
      execution_context: {
        conversationJid: 'tg:team',
        threadId: 'topic-1',
        workspaceKey: 'main_agent',
      },
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-04-24T08:00:00.000Z',
        fingerprint: 'setup-browser',
        blockers: [],
      },
      recovery_intent: {
        kind: 'missing_capability',
        state: 'pending',
        dedupe_key: 'dedupe-1',
        created_at: '2026-04-24T08:00:00.000Z',
        updated_at: '2026-04-24T08:00:00.000Z',
        source_run_id: null,
        setup_fingerprint: 'setup-browser',
        requirement_type: 'browser',
        requirement_id: 'Browser',
        next_action: 'request_permission',
        attempts: 0,
        last_error: null,
      },
    });
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const rehydratePendingRecoveryTurns = vi.fn().mockResolvedValue(undefined);
    const deps = {
      conversationRoutes: () => ({}),
      queue: {} as never,
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
      opsRepository: {
        releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
        getAllJobs: vi.fn().mockResolvedValue([job]),
      } as never,
    };
    const engine = new PgBossSchedulerEngine(deps, {
      registerSystemJobs: vi.fn().mockResolvedValue(undefined),
      runJob: vi.fn().mockResolvedValue(undefined),
      sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      rehydratePendingRecoveryTurns,
    });
    (engine as unknown as { boss: typeof boss }).boss = boss;

    await (
      engine as unknown as { syncAllJobs: () => Promise<void> }
    ).syncAllJobs();

    expect(rehydratePendingRecoveryTurns).toHaveBeenCalledWith([job], deps);
  });

  it('dead-letters active once jobs with invalid persisted next_run', async () => {
    const job = createJob({
      next_run: 'not a timestamp',
    });
    const updateJob = vi.fn().mockResolvedValue(undefined);
    const onSchedulerChanged = vi.fn();
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
          getAllJobs: vi.fn().mockResolvedValue([job]),
          updateJob,
        } as never,
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

    expect(updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'dead_lettered',
        pause_reason: 'Invalid once next_run: not a timestamp',
        next_run: null,
      }),
    );
    expect(onSchedulerChanged).toHaveBeenCalledWith('job-1');
    expect(boss.send).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            jobId: 'job-1',
            runId: 'run-1',
            releasedAt: '2026-04-24T08:00:00.000Z',
            runTimedOut: true,
            reason: 'lease_expired',
          },
        ]),
      getAllJobs: vi.fn().mockResolvedValue([activeJob]),
    };
    const onSchedulerChanged = vi.fn();
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
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

  it('startup recovery only releases expired leases, never live ones', async () => {
    const release = {
      jobId: 'job-1',
      runId: 'run-1',
      releasedAt: '2026-04-24T08:00:00.000Z',
      runTimedOut: true,
      reason: 'lease_expired',
    };
    const opsRepository = {
      getAllJobs: vi.fn().mockResolvedValue([]),
      releaseStaleJobLeases: vi.fn().mockResolvedValue([release]),
    };
    const onSchedulerChanged = vi.fn();
    const handleReleasedStaleLeases = vi.fn().mockResolvedValue(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
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
        handleReleasedStaleLeases,
      },
    );
    (engine as unknown as { boss: unknown }).boss = {
      schedule: vi.fn(),
      unschedule: vi.fn(),
      send: vi.fn(),
      deleteJob: vi.fn(),
    };

    await (
      engine as unknown as { syncAllJobs: () => Promise<void> }
    ).syncAllJobs();

    expect(opsRepository.releaseStaleJobLeases).toHaveBeenCalledTimes(1);
    expect(handleReleasedStaleLeases).toHaveBeenCalledWith(
      [release],
      expect.objectContaining({ opsRepository }),
    );
    expect(onSchedulerChanged).toHaveBeenCalledWith();
  });

  it('startup recovery releases slots held by already stale workers', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-24T08:00:00.000Z'));
      workerCoordination.releaseRunSlotsForStaleWorkers.mockResolvedValue(2);
      const opsRepository = {
        getAllJobs: vi.fn().mockResolvedValue([]),
        releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
      };
      const engine = new PgBossSchedulerEngine(
        {
          conversationRoutes: () => ({}),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage: vi.fn(),
          opsRepository: opsRepository as never,
        },
        {
          registerSystemJobs: vi.fn().mockResolvedValue(undefined),
          runJob: vi.fn().mockResolvedValue(undefined),
          sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
        },
      );
      (engine as unknown as { boss: unknown }).boss = {
        schedule: vi.fn(),
        unschedule: vi.fn(),
        send: vi.fn(),
        deleteJob: vi.fn(),
      };

      await (
        engine as unknown as { syncAllJobs: () => Promise<void> }
      ).syncAllJobs();

      expect(
        workerCoordination.releaseRunSlotsForStaleWorkers,
      ).toHaveBeenCalledWith({
        staleBefore: toIso(nowMs() - WORKER_STALE_AFTER_MS),
      });
      expect(workerCoordination.recoverExpiredRunLeases).toHaveBeenCalledWith({
        staleBefore: toIso(nowMs() - WORKER_STALE_AFTER_MS),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('periodically runs a full sync so stale leases are released while idle', async () => {
    vi.useFakeTimers();
    try {
      const activeJob = createJob();
      const boss = {
        send: vi.fn().mockResolvedValue(undefined),
        schedule: vi.fn().mockResolvedValue(undefined),
        unschedule: vi.fn().mockResolvedValue(undefined),
        deleteJob: vi.fn().mockResolvedValue(undefined),
      };
      const opsRepository = {
        releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
        getAllJobs: vi.fn().mockResolvedValue([activeJob]),
      };
      const engine = new PgBossSchedulerEngine(
        {
          conversationRoutes: () => ({}),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage: vi.fn(),
          opsRepository: opsRepository as never,
        },
        {
          registerSystemJobs: vi.fn().mockResolvedValue(undefined),
          runJob: vi.fn().mockResolvedValue(undefined),
          sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
        },
      );
      (engine as unknown as { boss: typeof boss }).boss = boss;

      (
        engine as unknown as { startMaintenanceTimer: () => void }
      ).startMaintenanceTimer();
      await vi.advanceTimersByTimeAsync(SCHEDULER_MAINTENANCE_SYNC_INTERVAL_MS);

      expect(opsRepository.releaseStaleJobLeases).toHaveBeenCalledTimes(1);

      (
        engine as unknown as { stopMaintenanceTimer: () => void }
      ).stopMaintenanceTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules cron jobs with the single durable pg-boss job queue', async () => {
    const cronJob = createJob({
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run: '2026-04-25T09:00:00.000Z',
      workspace_key: 'sl:team',
    });
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
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
      'gantry.jobs',
      '0 9 * * *',
      { jobId: 'job-1' },
      expect.objectContaining({
        key: 'gantry.job.am9iLTE',
        group: { id: 'gantry.group.c2w6dGVhbQ' },
        singletonKey: 'gantry.job.am9iLTE',
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
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          releaseStaleJobLeases: vi.fn().mockResolvedValue([]),
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

  it('enqueues manual trigger jobs with a pg-boss UUID id and preserves trigger payload', async () => {
    const job = createJob({ schedule_type: 'manual', next_run: null });
    runtimeStore.controlRepository.getTriggerById.mockResolvedValueOnce({
      triggerId: '3ed752cc-6bf0-4055-b42c-b2ea3c415173',
      requestedAt: '2026-05-07T02:35:00.000Z',
    });
    const boss = {
      send: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      unschedule: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    (engine as unknown as { boss: typeof boss }).boss = boss;

    await engine.enqueueTrigger(
      'job-1',
      '3ed752cc-6bf0-4055-b42c-b2ea3c415173',
      { runId: '55cda2f6-e553-486a-867f-b9c78a742217' },
    );

    expect(boss.send).toHaveBeenCalledWith(
      'gantry.jobs',
      {
        jobId: 'job-1',
        runId: '55cda2f6-e553-486a-867f-b9c78a742217',
        triggerId: '3ed752cc-6bf0-4055-b42c-b2ea3c415173',
        scheduledFor: '2026-05-07T02:35:00.000Z',
      },
      expect.objectContaining({
        id: expect.stringMatching(UUID_PATTERN),
        group: { id: 'gantry.group.dGc6dGVhbQ' },
        retryLimit: 0,
      }),
    );
    expect(boss.send.mock.calls[0][2].id).not.toContain('gantry.send.');
  });

  it('dispatches jobs through a job-scoped scheduler queue key and releases the slot', async () => {
    runtimeQueueConfigMock.value = {
      maxMessageRuns: 0,
      maxJobRuns: 4,
      maxRetries: 5,
    };
    const acquireRunSlot = vi.fn(async () => true);
    configureRunSlotBackend({
      repository: {
        acquireRunSlot,
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob({
      workspace_key: 'tg:team',
    });
    const callbacks = {
      registerSystemJobs: vi.fn().mockResolvedValue(undefined),
      runJob: vi.fn().mockResolvedValue(undefined),
      sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
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
        ) => Promise<void>;
      }
    ).processBossJobs([
      { data: { jobId: 'job-1', triggerId: 'trigger-1', runId: 'run-1' } },
    ]);

    expect(callbacks.runJob).toHaveBeenCalledWith(
      job,
      expect.any(Object),
      '__scheduler__:tg:team:job-1',
      { jobId: 'job-1', triggerId: 'trigger-1', runId: 'run-1' },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    const workspaceAcquire = acquireRunSlot.mock.calls.find(
      ([input]) => input.slotKey === 'tg:team',
    )?.[0];
    expect(workspaceAcquire).toEqual(
      expect.objectContaining({ slotKey: 'tg:team' }),
    );
    expect(workspaceAcquire?.capacity).toBe(4);
    expect(workspaceAcquire?.runId).toBe('run-1');
    const hostAcquire = acquireRunSlot.mock.calls.find(([input]) =>
      String(input.slotKey).endsWith(':background'),
    )?.[0];
    expect(hostAcquire?.capacity).toBe(4);
    expect(hostAcquire?.runId).toBe('run-1');
    expect(
      acquireRunSlot.mock.calls.some(
        ([input]) =>
          String(input.slotKey).startsWith('host:execution:') &&
          !String(input.slotKey).endsWith(':background'),
      ),
    ).toBe(true);
    expect(requestSync).toHaveBeenCalledWith();
  });

  it('dispatches background jobs before system maintenance jobs', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => true),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const maintenanceJob = createJob({
      id: 'system:dreaming:team:abc123',
      prompt: '__system:memory_dream',
    });
    const backgroundJob = createJob({
      id: 'background-job',
      prompt: 'Summarize the channel',
    });
    const callbacks = {
      registerSystemJobs: vi.fn().mockResolvedValue(undefined),
      runJob: vi.fn().mockResolvedValue(undefined),
      sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          getJobById: vi.fn(async (jobId: string) =>
            jobId === 'system:dreaming:team:abc123'
              ? maintenanceJob
              : backgroundJob,
          ),
        } as never,
      },
      callbacks,
    );

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string; runId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([
      {
        data: {
          jobId: 'system:dreaming:team:abc123',
          runId: 'maintenance-run',
        },
      },
      { data: { jobId: 'background-job', runId: 'background-run' } },
    ]);

    expect(callbacks.runJob.mock.calls.map((call) => call[0].id)).toEqual([
      'background-job',
      'system:dreaming:team:abc123',
    ]);
  });

  it('does not put untrusted reserved prompts in the maintenance lane', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => true),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const rogueReservedPromptJob = createJob({
      id: 'rogue-job',
      prompt: '__system:memory_dream',
    });
    const backgroundJob = createJob({
      id: 'background-job',
      prompt: 'Summarize the channel',
    });
    const callbacks = {
      registerSystemJobs: vi.fn().mockResolvedValue(undefined),
      runJob: vi.fn().mockResolvedValue(undefined),
      sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
    };
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          getJobById: vi.fn(async (jobId: string) =>
            jobId === 'rogue-job' ? rogueReservedPromptJob : backgroundJob,
          ),
        } as never,
      },
      callbacks,
    );

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string; runId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([
      { data: { jobId: 'rogue-job', runId: 'rogue-run' } },
      { data: { jobId: 'background-job', runId: 'background-run' } },
    ]);

    expect(callbacks.runJob.mock.calls.map((call) => call[0].id)).toEqual([
      'rogue-job',
      'background-job',
    ]);
  });

  it('notifies with the job delay copy when background job capacity is full', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => false),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob({
      notification_routes: [
        {
          conversationJid: 'tg:ops',
          threadId: null,
          label: 'Ops',
        },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage,
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string; runId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: { jobId: 'job-1', runId: 'run-1' } }]);

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:ops',
      JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT,
    );
  });

  it('requeues zero-capacity background deliveries instead of running them', async () => {
    runtimeQueueConfigMock.value = {
      maxMessageRuns: 3,
      maxJobRuns: 0,
      maxRetries: 5,
    };
    const acquireRunSlot = vi.fn(async () => true);
    configureRunSlotBackend({
      repository: {
        acquireRunSlot,
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob({
      notification_routes: [
        {
          conversationJid: 'tg:ops',
          threadId: null,
          label: 'Ops',
        },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const runJob = vi.fn().mockResolvedValue(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage,
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob,
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send,
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string; runId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: { jobId: 'job-1', runId: 'run-zero' } }]);

    expect(runJob).not.toHaveBeenCalled();
    expect(acquireRunSlot).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:ops',
      JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT,
    );
  });

  it('dedupes job delay copy across workers while the same delivery remains capacity blocked', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => false),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob({
      notification_routes: [
        {
          conversationJid: 'tg:ops',
          threadId: null,
          label: 'Ops',
        },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage,
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send,
    };
    const blockedDelivery = {
      data: { jobId: 'job-1', runId: 'run-delay-dedupe' },
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string; runId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([blockedDelivery]);
    const requeuedPayload = send.mock.calls[0]?.[1] as {
      jobId: string;
      runId: string;
      capacityDelayNotified?: boolean;
    };
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => false),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test-2',
    });
    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{
            data: {
              jobId: string;
              runId: string;
              capacityDelayNotified?: boolean;
            };
          }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: requeuedPayload }]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(requeuedPayload).toMatchObject({ capacityDelayNotified: true });
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      capacityDelayNotified: true,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:ops',
      JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT,
    );
  });

  it('does not resend job delay copy when a blocked delivery stays delayed past the old throttle window', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
      configureRunSlotBackend({
        repository: {
          acquireRunSlot: vi.fn(async () => false),
          renewRunSlot: vi.fn(async () => true),
          releaseRunSlot: vi.fn(async () => undefined),
        },
        workerInstanceId: 'worker-test',
      });
      const job = createJob({
        notification_routes: [
          {
            conversationJid: 'tg:ops',
            threadId: null,
            label: 'Ops',
          },
        ],
      });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const engine = new PgBossSchedulerEngine(
        {
          conversationRoutes: () => ({}),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage,
          opsRepository: {
            getJobById: vi.fn().mockResolvedValue(job),
          } as never,
        },
        {
          registerSystemJobs: vi.fn().mockResolvedValue(undefined),
          runJob: vi.fn().mockResolvedValue(undefined),
          sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
        },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss =
        {
          send,
        };
      const blockedDelivery = {
        data: { jobId: 'job-1', runId: 'run-delay-no-expire' },
      };

      await (
        engine as unknown as {
          processBossJobs: (
            jobs: Array<{ data: { jobId: string; runId: string } }>,
          ) => Promise<void>;
        }
      ).processBossJobs([blockedDelivery]);
      const requeuedPayload = send.mock.calls[0]?.[1] as {
        jobId: string;
        runId: string;
        capacityDelayNotified?: boolean;
      };
      vi.setSystemTime(new Date('2026-06-19T00:20:00.000Z'));
      await (
        engine as unknown as {
          processBossJobs: (
            jobs: Array<{
              data: {
                jobId: string;
                runId: string;
                capacityDelayNotified?: boolean;
              };
            }>,
          ) => Promise<void>;
        }
      ).processBossJobs([{ data: requeuedPayload }]);

      expect(send).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists delivered capacity delay copy state on the requeued delivery', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => false),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob({
      notification_routes: [
        {
          conversationJid: 'tg:ops',
          threadId: null,
          label: 'Ops',
        },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage,
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send,
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string; runId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([
      { data: { jobId: 'job-1', runId: 'run-notify-async' } },
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:ops',
      JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT,
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      capacityDelayNotified: true,
    });
  });

  it('retries capacity delay copy until at least one route reports delivery', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => false),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob({
      notification_routes: [
        {
          conversationJid: 'tg:ops',
          threadId: null,
          label: 'Ops',
        },
      ],
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage,
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send,
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{
            data: {
              jobId: string;
              runId: string;
              capacityDelayNotified?: boolean;
            };
          }>,
        ) => Promise<void>;
      }
    ).processBossJobs([
      { data: { jobId: 'job-1', runId: 'run-notify-retry' } },
    ]);
    const firstRequeuedPayload = send.mock.calls[0]?.[1] as {
      jobId: string;
      runId: string;
      capacityDelayNotified?: boolean;
    };
    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{
            data: {
              jobId: string;
              runId: string;
              capacityDelayNotified?: boolean;
            };
          }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: firstRequeuedPayload }]);
    const secondRequeuedPayload = send.mock.calls[1]?.[1] as {
      jobId: string;
      runId: string;
      capacityDelayNotified?: boolean;
    };
    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{
            data: {
              jobId: string;
              runId: string;
              capacityDelayNotified?: boolean;
            };
          }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: secondRequeuedPayload }]);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(firstRequeuedPayload).toMatchObject({
      capacityDelayNotified: false,
    });
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      capacityDelayNotified: true,
    });
    expect(send.mock.calls[2]?.[1]).toMatchObject({
      capacityDelayNotified: true,
    });
  });

  it('requeues delivery without claiming slots while chat admission is backlogged', async () => {
    const acquireRunSlot = vi.fn(async () => true);
    configureRunSlotBackend({
      repository: {
        acquireRunSlot,
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob();
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        hasLiveAdmissionBacklog: vi.fn().mockResolvedValue(true),
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send,
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: { jobId: 'job-1' } }]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(acquireRunSlot).not.toHaveBeenCalled();
  });

  it('does not idle a dedicated job-worker for unrelated chat backlog', async () => {
    const acquireRunSlot = vi.fn(async () => true);
    configureRunSlotBackend({
      repository: {
        acquireRunSlot,
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob();
    const runJob = vi.fn().mockResolvedValue(undefined);
    const hasLiveAdmissionBacklog = vi.fn().mockResolvedValue(true);
    const engine = new PgBossSchedulerEngine(
      {
        processRole: 'job-worker',
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        hasLiveAdmissionBacklog,
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob,
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send,
    };

    await (
      engine as unknown as {
        processBossJobs: (
          jobs: Array<{ data: { jobId: string } }>,
        ) => Promise<void>;
      }
    ).processBossJobs([{ data: { jobId: 'job-1' } }]);

    expect(hasLiveAdmissionBacklog).not.toHaveBeenCalled();
    expect(runJob).toHaveBeenCalled();
    expect(acquireRunSlot).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const acquiredRunIds = acquireRunSlot.mock.calls
      .map(([input]) => input.runId)
      .filter(Boolean);
    expect(new Set(acquiredRunIds).size).toBe(1);
    expect(acquiredRunIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(runJob.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ runId: acquiredRunIds[0] }),
    );
  });

  it('fails the pg-boss delivery when capacity requeue cannot be persisted', async () => {
    configureRunSlotBackend({
      repository: {
        acquireRunSlot: vi.fn(async () => false),
        renewRunSlot: vi.fn(async () => true),
        releaseRunSlot: vi.fn(async () => undefined),
      },
      workerInstanceId: 'worker-test',
    });
    const job = createJob();
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
        } as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const requeueError = new Error('pg-boss send failed');
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send: vi.fn().mockRejectedValue(requeueError),
    };

    await expect(
      (
        engine as unknown as {
          processBossJobs: (
            jobs: Array<{ data: { jobId: string } }>,
          ) => Promise<void>;
        }
      ).processBossJobs([{ data: { jobId: 'job-1' } }]),
    ).rejects.toThrow('pg-boss send failed');
  });

  it('fails the pg-boss delivery when ineligible requeue cannot be persisted', async () => {
    deploymentModeMock.mode = 'fleet';
    const job = createJob({
      workspace_key: 'agent:a',
      required_capabilities: ['skill:missing'],
    } as Partial<Job>);
    const updateJob = vi.fn().mockResolvedValue(undefined);
    const engine = new PgBossSchedulerEngine(
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(),
        opsRepository: {
          getJobById: vi.fn().mockResolvedValue(job),
          updateJob,
        } as never,
        getSkillRepository: () =>
          ({
            listAgentSkillBindings: async () => [
              {
                skillId: 'missing',
                status: 'active',
              },
            ],
          }) as never,
      },
      {
        registerSystemJobs: vi.fn().mockResolvedValue(undefined),
        runJob: vi.fn().mockResolvedValue(undefined),
        sweepCompletedOneTimeJobs: vi.fn().mockResolvedValue(false),
      },
    );
    const requeueError = new Error('pg-boss send failed');
    (engine as unknown as { boss: { send: ReturnType<typeof vi.fn> } }).boss = {
      send: vi.fn().mockRejectedValue(requeueError),
    };

    await expect(
      (
        engine as unknown as {
          processBossJobs: (
            jobs: Array<{ data: { jobId: string } }>,
          ) => Promise<void>;
        }
      ).processBossJobs([{ data: { jobId: 'job-1' } }]),
    ).rejects.toThrow('pg-boss send failed');
    expect(updateJob).not.toHaveBeenCalled();
  });
});
