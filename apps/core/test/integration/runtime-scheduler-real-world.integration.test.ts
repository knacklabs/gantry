import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

function registerMainAndTeam(
  harness: Awaited<ReturnType<typeof createHermeticRuntimeHarness>>,
) {
  harness.registerGroup({
    jid: 'tg:main',
    name: 'Main',
    folder: 'main',
    trigger: 'Andy',
    isMain: true,
    requiresTrigger: false,
  });
  harness.registerGroup({
    jid: 'tg:team',
    name: 'Team',
    folder: 'team',
    trigger: '@Andy',
    requiresTrigger: true,
  });
}

describe('real-world scheduler restart and operational scenarios', () => {
  it('uses bounded missed-run catch-up after long downtime instead of bursting every historical cron occurrence', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'downtime-catchup-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'downtime-cron-job',
      name: 'Downtime Cron Job',
      prompt: 'run after downtime',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () => harness.fakeAgent.invocations.length === 1,
      4_000,
    );

    expect(
      harness.db
        .getRecentJobRuns(50)
        .filter((run) => run.job_id === 'downtime-cron-job'),
    ).toHaveLength(1);
    expect(harness.db.getJobById('downtime-cron-job')?.next_run).toBeTruthy();
  });

  it('does not double-run a due job when scheduler ticks overlap while the job is leased', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'overlap-result',
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'overlap-due-job',
      name: 'Overlap Due Job',
      prompt: 'run once under overlap',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });

    await harness.runSchedulerOnce({ awaitTasks: false });
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);
    await harness.runSchedulerOnce();

    expect(harness.fakeAgent.invocations).toHaveLength(1);

    harness.fakeAgent.releaseAll();
    await harness.waitFor(
      () =>
        harness.db
          .getRecentJobRuns(20)
          .some(
            (run) =>
              run.job_id === 'overlap-due-job' && run.status === 'completed',
          ),
      4_000,
    );
  });

  it('does not rerun a completed one-time job across repeated scheduler ticks', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'completed-once-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'completed-once-job',
      name: 'Completed Once Job',
      prompt: 'run one time only under repeated ticks',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () => harness.db.getJobById('completed-once-job')?.status === 'completed',
      4_000,
    );

    for (let i = 0; i < 5; i += 1) {
      await harness.runSchedulerOnce();
    }

    const runs = harness.db
      .getRecentJobRuns(20)
      .filter((run) => run.job_id === 'completed-once-job');
    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
  });

  it('delete during an active run cancels future delivery and restart resurrection', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'deleted-job-result-should-not-deliver',
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.db.upsertJob({
      id: 'delete-active-job',
      name: 'Delete Active Job',
      prompt: 'delete while active',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });

    try {
      await harness.runSchedulerOnce({ awaitTasks: false });
      await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);

      harness.writeIpcTaskRequest('main', {
        type: 'scheduler_delete_job',
        jobId: 'delete-active-job',
      });
      await harness.waitFor(
        () => harness.db.getJobById('delete-active-job') === undefined,
      );

      harness.fakeAgent.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await harness.runSchedulerOnce();

      expect(harness.db.getJobById('delete-active-job')).toBeUndefined();
      expect(
        harness.channel.outbound.some((msg) =>
          msg.text.includes('deleted-job-result-should-not-deliver'),
        ),
      ).toBe(false);
    } finally {
      harness.fakeAgent.releaseAll();
    }
  });

  it('does not start a second copy while the original long-running job is still alive but its lease expires', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'long-job-result',
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'lease-expiry-job',
      name: 'Lease Expiry Job',
      prompt: 'long running lease',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });

    try {
      await harness.runSchedulerOnce({ awaitTasks: false });
      await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);

      harness.db.updateJob('lease-expiry-job', {
        lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
      });
      await harness.runSchedulerOnce({ awaitTasks: false });

      expect(harness.fakeAgent.invocations).toHaveLength(1);
    } finally {
      harness.fakeAgent.releaseAll();
    }
  });

  it('does not run a paused job while stale lease recovery is happening', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'paused-recovery-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'paused-recovery-job',
      name: 'Paused Recovery Job',
      prompt: 'do not run while paused',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'paused',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });
    harness.db.updateJob('paused-recovery-job', {
      lease_run_id: 'stale-paused-run',
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
      pause_reason: 'Paused by user during recovery',
    });

    await harness.runSchedulerOnce();

    expect(harness.fakeAgent.invocations).toHaveLength(0);
    expect(harness.db.getJobById('paused-recovery-job')).toEqual(
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Paused by user during recovery',
      }),
    );
  });

  it('uses the updated schedule after a retrying job is mutated during backoff', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        sequence: [
          { failWithError: 'first run fails into backoff' },
          { resultText: 'backoff-mutation-success' },
        ],
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.db.upsertJob({
      id: 'backoff-mutation-job',
      name: 'Backoff Mutation Job',
      prompt: 'fail then mutate',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
      retry_backoff_ms: 60_000,
      max_retries: 2,
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db.getJobById('backoff-mutation-job')?.consecutive_failures ===
        1,
      4_000,
    );

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_update_job',
      jobId: 'backoff-mutation-job',
      scheduleValue: '*/10 * * * *',
      prompt: 'mutated after backoff',
    });
    await harness.waitFor(
      () =>
        harness.db.getJobById('backoff-mutation-job')?.schedule_value ===
        '*/10 * * * *',
    );

    harness.db.updateJob('backoff-mutation-job', {
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db.getJobById('backoff-mutation-job')?.consecutive_failures ===
        0,
      4_000,
    );

    expect(harness.fakeAgent.invocations[1]?.prompt).toBe(
      'mutated after backoff',
    );
    expect(harness.db.getJobById('backoff-mutation-job')?.schedule_value).toBe(
      '*/10 * * * *',
    );
  });

  it('computes stable cron next_run state for a local wall-clock DST-gap schedule without immediate duplicate execution', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'dst-gap-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_upsert_job',
      jobId: 'dst-gap-job',
      name: 'DST Gap Job',
      prompt: 'run at local 02:30',
      scheduleType: 'cron',
      scheduleValue: '30 2 * * *',
      deliverTo: ['tg:main'],
      groupScope: 'main',
    });

    await harness.waitFor(() => Boolean(harness.db.getJobById('dst-gap-job')));
    const created = harness.db.getJobById('dst-gap-job');
    expect(created?.next_run).toBeTruthy();

    harness.db.updateJob('dst-gap-job', {
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    await harness.runSchedulerOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);
    await harness.runSchedulerOnce();

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.db.getJobById('dst-gap-job')?.next_run).toBeTruthy();
  });
});
