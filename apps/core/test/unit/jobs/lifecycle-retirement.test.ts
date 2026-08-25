import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationRoute, Job, JobRun } from '@core/domain/types.js';
import type { SchedulerDependencies } from '@core/jobs/types.js';
import { createSchedulerLifecycleNotificationUpdater } from '@core/app/bootstrap/scheduler-lifecycle-notification.js';
import { notifySchedulerTerminalRunState } from '@core/jobs/execution-notifications.js';

const runtimeStore = vi.hoisted(() => ({
  publish: vi.fn(async () => undefined),
  appendRunnerControlEvent: vi.fn(async () => 'persisted'),
  heartbeatRunLease: vi.fn(async () => true),
  bindPendingTriggerToRun: vi.fn(async () => null),
  bindTriggerToRun: vi.fn(async () => null),
  getAppSessionById: vi.fn(async () => null),
  markTriggerCompleted: vi.fn(async () => undefined),
  runSystemJobTurn: vi.fn(async () => ({
    result: 'System job completed.',
    error: null as string | null,
  })),
}));

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/config/index.js')>();
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    getEffectiveModelConfig: () => ({ model: 'opus' }),
  };
});

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: () => '/tmp/gantry-lifecycle-retirement',
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => ({
    bindPendingTriggerToRun: runtimeStore.bindPendingTriggerToRun,
    bindTriggerToRun: runtimeStore.bindTriggerToRun,
    getAppSessionById: runtimeStore.getAppSessionById,
    markTriggerCompleted: runtimeStore.markTriggerCompleted,
  }),
  getRuntimeEventExchange: () => ({
    publish: runtimeStore.publish,
    list: async () => [],
  }),
  getWorkerCoordinationRepository: () => ({
    appendRunnerControlEvent: runtimeStore.appendRunnerControlEvent,
    heartbeatRunLease: runtimeStore.heartbeatRunLease,
  }),
  getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
}));

vi.mock('@core/jobs/worker-identity.js', () => ({
  requireWorkerInstanceId: () => 'worker-test',
}));

vi.mock('@core/jobs/execution-system-job.js', () => ({
  runSystemJobTurn: runtimeStore.runSystemJobTurn,
}));

vi.mock('@core/shared/system-job-identity.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@core/shared/system-job-identity.js')
    >();
  return { ...actual, isTrustedSystemJob: () => true };
});

const { runJob } = await import('@core/jobs/execution.js');
const { deadLetterUnresolvedExecutionContext } =
  await import('@core/jobs/execution-dead-letter.js');
const { notifyReleasedStaleJobLeases } =
  await import('@core/jobs/stale-lease-terminal.js');

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Daily summary',
    prompt: 'System maintenance',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: 'thread-1',
    workspace_key: 'scheduler_agent',
    created_by: 'human',
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 1,
    timeout_ms: 30_000,
    max_retries: 0,
    retry_backoff_ms: 0,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    execution_context: {
      conversationJid: 'tg:scheduler',
      threadId: 'thread-1',
      workspaceKey: 'scheduler_agent',
    },
    notification_routes: [
      {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-1',
        label: 'Primary',
      },
    ],
    ...overrides,
  };
}

function terminalDeps(job: Job) {
  const sendMessage = vi.fn(async () => undefined);
  const updateLifecycleNotification = vi.fn(async () =>
    (job.notification_routes ?? []).map((route) => ({
      route: {
        ...route,
        threadId: route.threadId ?? null,
        label: route.label ?? 'Primary',
      },
      status: 'updated' as const,
    })),
  );
  const repository = {
    getJobById: vi.fn(async () => job),
    getJobRunById: vi.fn(async (runId: string) => ({
      run_id: runId,
      job_id: job.id,
      short_id: 1,
      status: 'running',
      retry_count: 0,
      started_at: '2026-08-06T00:00:00.000Z',
      ended_at: '2026-08-06T00:00:01.000Z',
    })),
    claimDueJobRunStart: vi.fn(async (input) => ({
      runId: input.runId,
      jobId: input.jobId,
      workerInstanceId: 'worker-test',
      leaseToken: 'lease-token',
      fencingVersion: 1,
      status: 'active' as const,
      claimedAt: input.startedAt,
      expiresAt: input.leaseExpiresAt,
      heartbeatAt: input.startedAt,
    })),
    settleJobRunLease: vi.fn(async () => true),
    finalizeJobRunLease: vi.fn(async () => true),
    finalizeJobRunWithLease: vi.fn(async () => true),
    markJobRunNotified: vi.fn(async () => true),
    updateJob: vi.fn(async () => undefined),
    createJobRun: vi.fn(async () => undefined),
    listRecentJobEvents: vi.fn(async () => []),
  };
  const route: ConversationRoute = {
    name: 'Scheduler',
    folder: 'scheduler_agent',
    trigger: '',
    added_at: '2026-08-06T00:00:00.000Z',
    requiresTrigger: false,
  };
  const deps = {
    conversationRoutes: () => ({ 'tg:scheduler': route }),
    queue: {} as never,
    onProcess: vi.fn(),
    sendMessage,
    updateLifecycleNotification,
    opsRepository: repository,
    runAgent: vi.fn(),
    executionAdapter: { id: 'fake:test-execution' },
    runnerSandboxProvider: { id: 'direct', enforcing: false } as never,
  } as unknown as SchedulerDependencies;
  return { deps, repository, sendMessage, updateLifecycleNotification };
}

describe('lifecycle retirement', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    runtimeStore.runSystemJobTurn.mockResolvedValue({
      result: 'System job completed.',
      error: null,
    });
  });

  it('starts the lease heartbeat before lifecycle card provider I/O settles', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const primary = terminalDeps(job);
    let releaseRunLookup!: () => void;
    const runLookupGate = new Promise<void>((resolve) => {
      releaseRunLookup = resolve;
    });
    primary.repository.getJobRunById.mockImplementation(async (runId) => {
      await runLookupGate;
      return {
        run_id: runId,
        job_id: job.id,
        short_id: 1,
        status: 'running',
        retry_count: 0,
        started_at: '2026-08-06T00:00:00.000Z',
        ended_at: '2026-08-06T00:00:01.000Z',
      };
    });
    let settleCard!: (landed: boolean) => void;
    let markCardStarted!: () => void;
    const cardStarted = new Promise<void>((resolve) => {
      markCardStarted = resolve;
    });
    const cardSettlement = new Promise<boolean>((resolve) => {
      settleCard = resolve;
    });
    Object.assign(
      primary.deps,
      createSchedulerLifecycleNotificationUpdater({
        channelWiring: {
          sendProgressUpdate: vi.fn(async (_jid, text) => {
            if (text.startsWith('Running:')) {
              markCardStarted();
              return cardSettlement;
            }
            return true;
          }),
        },
      }),
    );

    const execution = runJob(job, primary.deps, 'tg:scheduler');
    await cardStarted;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runtimeStore.heartbeatRunLease).toHaveBeenCalledTimes(1);

    releaseRunLookup();
    settleCard(true);
    await execution;
  });

  it('does not wait for a never-settling lifecycle card before running the job', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    primary.deps.captureLifecycleNotification = vi.fn(
      () => new Promise<void>(() => undefined),
    );

    await expect(
      runJob(job, primary.deps, 'tg:scheduler'),
    ).resolves.toBeUndefined();

    expect(primary.repository.finalizeJobRunWithLease).toHaveBeenCalled();
  });

  it('retires a running card that lands after terminal fallback', async () => {
    const job = makeJob({
      schedule_type: 'cron',
      schedule_value: '* * * * *',
    });
    let settleCard!: (landed: boolean) => void;
    const cardSettlement = new Promise<boolean>((resolve) => {
      settleCard = resolve;
    });
    const sendProgressUpdate = vi.fn(async (_jid, text: string) =>
      text.startsWith('Running:') ? cardSettlement : true,
    );
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: { sendProgressUpdate },
    });
    const capture = lifecycle.captureLifecycleNotification?.({
      job,
      runId: 'run-late-card',
    });
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job,
      runId: 'run-late-card',
      runStatus: 'completed',
      summary: 'Finished.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification: lifecycle.updateLifecycleNotification,
    });
    settleCard(true);
    await capture;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendProgressUpdate).toHaveBeenLastCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        done: true,
        replaceOnly: true,
        progressCardIdentity: expect.stringContaining('scheduler-card:'),
      }),
    );
  });

  it('continues execution and clears lifecycle ownership when capture rejects', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    const discardLifecycleNotification = vi.fn();
    primary.deps.captureLifecycleNotification = vi.fn(async () => {
      throw new Error('route resolution failed');
    });
    primary.deps.discardLifecycleNotification = discardLifecycleNotification;

    await expect(
      runJob(job, primary.deps, 'tg:scheduler'),
    ).resolves.toBeUndefined();

    expect(discardLifecycleNotification).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(primary.repository.finalizeJobRunWithLease).toHaveBeenCalled();
  });

  it('retires and clears lifecycle ownership after an unexpected post-capture throw', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    let rejectRunLookup!: () => void;
    const runLookupGate = new Promise<void>((_resolve, reject) => {
      rejectRunLookup = () => reject(new Error('run lookup failed'));
    });
    primary.repository.getJobRunById.mockImplementation(async () => {
      await runLookupGate;
      throw new Error('unreachable');
    });
    let markRunningCardCreated!: () => void;
    const runningCardCreated = new Promise<void>((resolve) => {
      markRunningCardCreated = resolve;
    });
    const sendProgressUpdate = vi.fn(async (_jid, text: string) => {
      if (text.startsWith('Running:')) markRunningCardCreated();
      return true;
    });
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: { sendProgressUpdate },
    });
    const discardLifecycleNotification = vi.fn(
      lifecycle.discardLifecycleNotification,
    );
    Object.assign(primary.deps, lifecycle, { discardLifecycleNotification });

    const execution = runJob(job, primary.deps, 'tg:scheduler');
    await runningCardCreated;
    rejectRunLookup();

    await expect(execution).rejects.toThrow('run lookup failed');
    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('stopped unexpectedly'),
      expect.objectContaining({ done: true, replaceOnly: true }),
    );
    expect(discardLifecycleNotification).toHaveBeenCalledWith(
      expect.any(String),
    );

    const callsAfterExit = sendProgressUpdate.mock.calls.length;
    const runId = discardLifecycleNotification.mock.calls[0]![0];
    await lifecycle.updateLifecycleNotification?.({
      job,
      runId,
      runStatus: 'failed',
      summaryMessage: 'Should not find retained ownership.',
    });
    expect(sendProgressUpdate).toHaveBeenCalledTimes(callsAfterExit);
  });

  it('retires the lifecycle card when the failed-run failsafe rejects', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    primary.repository.getJobRunById.mockRejectedValue(
      new Error('run lookup failed'),
    );
    primary.repository.finalizeJobRunLease.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(runJob(job, primary.deps, 'tg:scheduler')).rejects.toThrow(
      'run lookup failed',
    );

    expect(primary.updateLifecycleNotification).toHaveBeenCalledWith(
      expect.objectContaining({ job, runStatus: 'failed' }),
    );
  });

  it('stops heartbeat and persists failure before a stalled lifecycle retirement', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const primary = terminalDeps(job);
    const order: string[] = [];
    let markRetirementStarted!: () => void;
    const retirementStarted = new Promise<void>((resolve) => {
      markRetirementStarted = resolve;
    });
    primary.repository.getJobRunById.mockRejectedValue(
      new Error('run lookup failed'),
    );
    primary.repository.finalizeJobRunLease.mockImplementation(async () => {
      order.push('persist');
      return true;
    });
    primary.deps.updateLifecycleNotification = vi.fn(() => {
      order.push('retire');
      markRetirementStarted();
      return new Promise(() => undefined);
    });

    const execution = runJob(job, primary.deps, 'tg:scheduler');
    const failedExecution =
      expect(execution).rejects.toThrow('run lookup failed');
    await retirementStarted;

    expect(order).toEqual(['persist', 'retire']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtimeStore.heartbeatRunLease).not.toHaveBeenCalled();
    await failedExecution;
  });

  it('retires and clears lifecycle ownership when the job is deleted during execution', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    primary.repository.getJobById
      .mockResolvedValueOnce(job)
      .mockResolvedValue(undefined);
    const sendProgressUpdate = vi.fn(async () => true);
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: { sendProgressUpdate },
    });
    const discardLifecycleNotification = vi.fn(
      lifecycle.discardLifecycleNotification,
    );
    Object.assign(primary.deps, lifecycle, { discardLifecycleNotification });

    await runJob(job, primary.deps, 'tg:scheduler');

    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('was deleted'),
      expect.objectContaining({ done: true, replaceOnly: true }),
    );
    expect(discardLifecycleNotification).toHaveBeenCalledWith(
      expect.any(String),
    );
  });

  it('does not overwrite a normally settled lifecycle card with a failure', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    const sendProgressUpdate = vi.fn(async () => true);
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: { sendProgressUpdate },
    });
    const discardLifecycleNotification = vi.fn(
      lifecycle.discardLifecycleNotification,
    );
    Object.assign(primary.deps, lifecycle, { discardLifecycleNotification });

    await runJob(job, primary.deps, 'tg:scheduler');

    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({ done: true, replaceOnly: true }),
    );
    expect(sendProgressUpdate).not.toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('stopped unexpectedly'),
      expect.anything(),
    );
    expect(discardLifecycleNotification).toHaveBeenCalledWith(
      expect.any(String),
    );
  });

  it('retires a nominally completed run as stopped unexpectedly when settlement fails', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    primary.repository.finalizeJobRunWithLease.mockRejectedValue(
      new Error('terminal settlement failed'),
    );

    await expect(runJob(job, primary.deps, 'tg:scheduler')).rejects.toThrow(
      'terminal settlement failed',
    );

    expect(primary.updateLifecycleNotification).toHaveBeenCalledTimes(1);
    expect(primary.updateLifecycleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        job,
        runStatus: 'failed',
        summaryMessage: expect.stringContaining('stopped unexpectedly'),
      }),
    );
    expect(primary.updateLifecycleNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runStatus: 'completed',
      }),
    );
  });

  it.each([
    {
      name: 'completed result',
      outcome: { result: 'Completed with 42 processed records.', error: null },
      status: 'completed' as const,
      summary: '42 processed records',
    },
    {
      name: 'failure error',
      outcome: { result: null, error: 'Upstream report export failed.' },
      status: 'failed' as const,
      summary: 'Upstream report export failed',
    },
  ])(
    'retries lifecycle retirement with the actual $name summary after a post-settlement update throws',
    async ({ outcome, status, summary }) => {
      const job = makeJob();
      const primary = terminalDeps(job);
      runtimeStore.runSystemJobTurn.mockResolvedValueOnce(outcome);
      primary.updateLifecycleNotification
        .mockRejectedValueOnce(new Error('terminal card update failed'))
        .mockResolvedValueOnce([
          {
            route: {
              conversationJid: 'tg:scheduler',
              threadId: 'thread-1',
              label: 'Primary',
            },
            status: 'updated',
          },
        ]);

      await expect(runJob(job, primary.deps, 'tg:scheduler')).rejects.toThrow(
        'terminal card update failed',
      );

      expect(primary.repository.finalizeJobRunWithLease).toHaveBeenCalled();
      expect(primary.updateLifecycleNotification).toHaveBeenCalledTimes(2);
      const [initial, retry] =
        primary.updateLifecycleNotification.mock.calls.map(([input]) => input);
      expect(initial).toEqual(
        expect.objectContaining({ job, runStatus: status }),
      );
      expect(retry).toEqual(
        expect.objectContaining({ job, runStatus: status }),
      );
      expect(retry?.summaryMessage).toContain(summary);
      expect(retry?.summaryMessage).not.toBe(`Job ${status}: ${job.name}.`);
    },
  );

  it('does not suppress fallback retirement for a failed route outcome', async () => {
    const job = makeJob();
    const primary = terminalDeps(job);
    let terminalAttempts = 0;
    const sendProgressUpdate = vi.fn(async (_jid: string, text: string) => {
      if (text.startsWith('Running:')) return true;
      terminalAttempts += 1;
      if (terminalAttempts === 1) {
        throw new Error('provider update rejected');
      }
      return true;
    });
    Object.assign(
      primary.deps,
      createSchedulerLifecycleNotificationUpdater({
        channelWiring: { sendProgressUpdate },
      }),
    );

    await runJob(job, primary.deps, 'tg:scheduler');

    const terminalCalls = sendProgressUpdate.mock.calls.filter(
      ([, text]) => !text.startsWith('Running:'),
    );
    expect(terminalCalls).toHaveLength(2);
    expect(terminalCalls[1]?.[2]).toEqual(
      expect.objectContaining({
        done: true,
        replaceOnly: true,
        progressCardIdentity: terminalCalls[0]?.[2]?.progressCardIdentity,
      }),
    );
  });

  it('primary terminal exit retires or replaces the originating running bubble', async () => {
    const primaryJob = makeJob();
    const primary = terminalDeps(primaryJob);
    const sendProgressUpdate = vi.fn(async () => true);
    Object.assign(
      primary.deps,
      createSchedulerLifecycleNotificationUpdater({
        channelWiring: {
          sendProgressUpdate,
        },
      }),
    );
    await runJob(primaryJob, primary.deps, 'tg:scheduler');
    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        threadId: 'thread-1',
        done: true,
        replaceOnly: true,
        progressCardIdentity: expect.stringContaining('scheduler-card:'),
      }),
    );
    expect(primary.sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        actionAffordances: [
          expect.objectContaining({
            kind: 'scheduler_run_now',
            label: 'Run again',
            jobId: primaryJob.id,
          }),
        ],
      }),
    );
  });

  it('dead-letter exit retires or replaces the running bubble', async () => {
    const deadLetterJob = makeJob({
      execution_context: {
        conversationJid: 'missing',
        threadId: null,
        workspaceKey: 'scheduler_agent',
      },
    });
    const deadLetter = terminalDeps(deadLetterJob);
    const sendProgressUpdate = vi.fn(async () => true);
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate,
      },
    });
    Object.assign(deadLetter.deps, lifecycle);
    await deadLetterUnresolvedExecutionContext({
      currentJob: deadLetterJob,
      deps: deadLetter.deps,
      runId: 'run-dead-letter',
      scheduledFor: '2026-08-06T00:00:00.000Z',
      startedAt: '2026-08-06T00:00:00.000Z',
      startedAtMs: Date.parse('2026-08-06T00:00:00.000Z'),
      runtimeAppId: 'default',
      control: {
        bindTriggerToRun: vi.fn(async () => undefined),
        bindPendingTriggerToRun: vi.fn(async () => undefined),
        getAppSessionById: vi.fn(async () => undefined),
        markTriggerCompleted: vi.fn(),
      },
      publishRuntimeEvent: vi.fn(async () => undefined),
      logger: { warn: vi.fn() },
    });
    expect(sendProgressUpdate).not.toHaveBeenCalled();
    expect(deadLetter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('stale-lease exit sends a terminal receipt without prior in-process capture', async () => {
    const staleJob = makeJob();
    const stale = terminalDeps(staleJob);
    const sendProgressUpdate = vi.fn(async () => true);
    const freshLifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate,
      },
    });
    await notifyReleasedStaleJobLeases({
      releases: [
        {
          jobId: staleJob.id,
          runId: 'run-stale',
          releasedAt: '2026-08-06T00:01:00.000Z',
          runTimedOut: true,
          reason: 'lease_expired',
        },
      ],
      opsRepository: {
        getJobById: stale.repository.getJobById,
        getJobRunById: stale.repository.getJobRunById as unknown as (
          runId: string,
        ) => Promise<JobRun | undefined>,
        markJobRunNotified: stale.repository.markJobRunNotified,
      },
      sendMessage: stale.sendMessage,
      updateLifecycleNotification: freshLifecycle.updateLifecycleNotification,
      controlRepository: { getAppSessionById: vi.fn(async () => undefined) },
      publishRuntimeEvent: vi.fn(async () => undefined),
    });
    expect(sendProgressUpdate).not.toHaveBeenCalled();
    expect(stale.sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Timed out'),
      expect.objectContaining({ threadId: 'thread-1' }),
    );
  });

  it("does not replace run B's card when run A terminates on the same route", async () => {
    const job = makeJob();
    const sendProgressUpdate = vi.fn(async () => true);
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate,
      },
    });
    await lifecycle.captureLifecycleNotification?.({ job, runId: 'run-a' });
    await lifecycle.captureLifecycleNotification?.({ job, runId: 'run-b' });
    const [runAStart, runBStart] = sendProgressUpdate.mock.calls.filter(
      ([, text]) => text === 'Running: Daily summary.',
    );
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job,
      runId: 'run-a',
      runStatus: 'completed',
      summary: 'Run A completed.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification: lifecycle.updateLifecycleNotification,
    });

    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        done: true,
        replaceOnly: true,
        progressCardIdentity: runAStart?.[2]?.progressCardIdentity,
      }),
    );
    expect(sendProgressUpdate).not.toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        progressCardIdentity: runBStart?.[2]?.progressCardIdentity,
      }),
    );
    const runATerminal = sendProgressUpdate.mock.calls.find(([, text]) =>
      text.includes('Completed'),
    );
    expect(runATerminal?.[2]?.generation).not.toBe(runBStart?.[2]?.generation);
    expect(runBStart?.[2]?.generation).toBeGreaterThan(
      runATerminal?.[2]?.generation,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back only on routes whose lifecycle update did not land', async () => {
    const job = makeJob({
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      notification_routes: [
        {
          conversationJid: 'tg:success',
          threadId: 'thread-success',
          label: 'Success',
        },
        {
          conversationJid: 'tg:failed',
          threadId: 'thread-failed',
          label: 'Failed',
        },
      ],
    });
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate: vi.fn(async (jid) => jid === 'tg:success'),
      },
    });
    await lifecycle.captureLifecycleNotification?.({
      job,
      runId: 'run-mixed',
    });
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job,
      runId: 'run-mixed',
      runStatus: 'completed',
      summary: 'Mixed route result.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification: lifecycle.updateLifecycleNotification,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:failed',
      expect.any(String),
      expect.objectContaining({ threadId: 'thread-failed' }),
    );
  });

  it('retires the running bubble and still sends Run again controls', async () => {
    const job = makeJob();
    const updateLifecycleNotification = vi.fn(async () =>
      (job.notification_routes ?? []).map((route) => ({
        route: { ...route, threadId: route.threadId ?? null },
        status: 'updated' as const,
      })),
    );
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job,
      runId: 'run-actionable',
      runStatus: 'completed',
      summary: 'Finished.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification,
    });

    expect(updateLifecycleNotification).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({
        actionAffordances: [
          expect.objectContaining({
            kind: 'scheduler_run_now',
            label: 'Run again',
          }),
        ],
      }),
    );
  });

  it('retires review-created lifecycle ownership before sending review actions', async () => {
    const job = makeJob();
    const sendProgressUpdate = vi.fn(async () => true);
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate,
      },
    });
    await lifecycle.captureLifecycleNotification?.({
      job,
      runId: 'run-review',
    });
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job,
      runId: 'run-review',
      runStatus: 'completed',
      summary: 'Memory review created.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification: lifecycle.updateLifecycleNotification,
      memoryReviewNotification: {
        kind: 'memory_review_created',
        createdReviewIds: ['review-1'],
        pendingCount: 1,
        reviewMessageView: {
          reviewId: 'review-1',
          kind: 'rewrite',
          title: '🧠 Memory review · update note',
          topic: 'user.timezone',
          sides: [],
          change: 'Use Asia/Kolkata.',
          why: 'The user stated a preferred timezone.',
          evidence: [],
          affordances: [
            {
              label: 'Approve',
              decision: 'approve',
              reviewId: 'review-1',
            },
            {
              label: 'Reject',
              decision: 'reject',
              reviewId: 'review-1',
            },
            {
              label: 'Edit',
              decision: 'edit',
              reviewId: 'review-1',
            },
          ],
        },
      },
    });

    expect(sendProgressUpdate).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.any(String),
      expect.objectContaining({
        actionAffordances: [
          expect.objectContaining({ kind: 'memory_review_decision' }),
          expect.objectContaining({ kind: 'memory_review_decision' }),
          expect.objectContaining({ kind: 'memory_review_decision' }),
        ],
      }),
    );

    const secondOutcomes = await lifecycle.updateLifecycleNotification?.({
      job,
      runId: 'run-review',
      runStatus: 'completed',
      summaryMessage: 'Already terminal.',
    });
    expect(secondOutcomes?.map((outcome) => outcome.status)).toEqual([
      'unsupported',
    ]);
    expect(sendProgressUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not replace a pre-existing route card when the run creates its own card', async () => {
    const job = makeJob();
    const sendProgressUpdate = vi.fn(async () => true);
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate,
      },
    });

    await lifecycle.captureLifecycleNotification?.({
      job,
      runId: 'run-owned',
    });
    await lifecycle.updateLifecycleNotification?.({
      job,
      runId: 'run-owned',
      runStatus: 'completed',
      summaryMessage: 'Completed.',
    });

    expect(sendProgressUpdate).not.toHaveBeenCalledWith(
      'tg:scheduler',
      expect.any(String),
      expect.objectContaining({ progressCardIdentity: 'unrelated-route-card' }),
    );
    expect(sendProgressUpdate).toHaveBeenLastCalledWith(
      'tg:scheduler',
      'Completed.',
      expect.objectContaining({
        replaceOnly: true,
        progressCardIdentity: expect.stringContaining('scheduler-card:'),
      }),
    );
  });

  it('sends a separate terminal notification when run-card creation does not land', async () => {
    const job = makeJob({
      schedule_type: 'cron',
      schedule_value: '* * * * *',
    });
    const lifecycle = createSchedulerLifecycleNotificationUpdater({
      channelWiring: {
        sendProgressUpdate: vi.fn(async () => false),
      },
    });
    await lifecycle.captureLifecycleNotification?.({ job, runId: 'run-none' });
    const sendMessage = vi.fn(async () => undefined);

    await notifySchedulerTerminalRunState({
      job,
      runId: 'run-none',
      runStatus: 'completed',
      summary: 'Finished.',
      nextRun: null,
      retryCount: 0,
      pauseReason: null,
      sendMessage,
      updateLifecycleNotification: lifecycle.updateLifecycleNotification,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('Completed'),
      expect.objectContaining({ threadId: 'thread-1' }),
    );
  });
});
