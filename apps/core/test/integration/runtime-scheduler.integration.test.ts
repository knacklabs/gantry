import fs from 'fs';

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
    trigger: 'Bot',
    requiresTrigger: true,
  });
}

describe('runtime scheduler integration', () => {
  it('creates and runs cron jobs through IPC, advances next_run, and avoids duplicate due execution', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'cron-result',
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_upsert_job',
      jobId: 'cron-job-1',
      name: 'Cron Job',
      prompt: 'Run cron task',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
      deliverTo: ['tg:main'],
      groupScope: 'main',
      executionMode: 'parallel',
    });

    await harness.waitFor(() => Boolean(harness.db.getJobById('cron-job-1')));
    const created = harness.db.getJobById('cron-job-1');
    expect(created?.schedule_type).toBe('cron');
    expect(created?.next_run).toBeTruthy();

    harness.db.updateJob('cron-job-1', {
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });

    await harness.runSchedulerOnce({ awaitTasks: false });
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);
    await harness.runSchedulerOnce();
    expect(harness.fakeAgent.invocations).toHaveLength(1);

    harness.fakeAgent.releaseAll();
    await harness.waitFor(() =>
      harness.db
        .getRecentJobRuns(20)
        .some(
          (run) => run.job_id === 'cron-job-1' && run.status === 'completed',
        ),
    );

    const completedJob = harness.db.getJobById('cron-job-1');
    expect(completedJob?.status).toBe('active');
    expect(completedJob?.next_run).toBeTruthy();
    expect(completedJob?.last_run).toBeTruthy();
    expect(
      harness.db
        .getRecentJobRuns(20)
        .filter((run) => run.job_id === 'cron-job-1'),
    ).toHaveLength(1);
  });

  it('rejects invalid, script-bearing, and unauthorized scheduler create requests', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_upsert_job',
      jobId: 'bad-cron',
      name: 'Bad Cron',
      prompt: 'Nope',
      schedule_type: 'cron',
      schedule_value: 'not a cron',
      deliverTo: ['tg:main'],
      groupScope: 'main',
    });
    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_once',
      jobId: 'script-once',
      name: 'Script Once',
      prompt: 'Nope',
      run_at: new Date().toISOString(),
      script: 'echo no',
      deliverTo: ['tg:main'],
      groupScope: 'main',
    });
    harness.writeIpcTaskRequest('team', {
      type: 'scheduler_once',
      jobId: 'cross-group-once',
      name: 'Cross Group',
      prompt: 'Nope',
      run_at: new Date().toISOString(),
      deliverTo: ['tg:main'],
      groupScope: 'main',
    });

    await harness.waitFor(
      () =>
        harness.listIpcFiles('main', 'tasks').length === 0 &&
        harness.listIpcFiles('team', 'tasks').length === 0,
      10_000,
    );
    expect(harness.db.getJobById('bad-cron')).toBeUndefined();
    expect(harness.db.getJobById('script-once')).toBeUndefined();
    expect(harness.db.getJobById('cross-group-once')).toBeUndefined();
  }, 15_000);

  it('runs one-time jobs once and immediately cleans them up when requested', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'once-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_once',
      jobId: 'once-job-1',
      name: 'Once Job',
      prompt: 'Run once task',
      run_at: new Date(Date.now() - 1_000).toISOString(),
      deliverTo: ['tg:main'],
      groupScope: 'main',
      cleanupAfterMs: 0,
    });

    await harness.waitFor(() => Boolean(harness.db.getJobById('once-job-1')));
    await harness.runSchedulerOnce();

    await harness.waitFor(
      () => harness.db.getJobById('once-job-1') === undefined,
    );
    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(
      harness.channel.outbound.some((msg) =>
        msg.text.includes('Scheduled task: Once Job'),
      ),
    ).toBe(true);
  });

  it('keeps manual jobs idle until scheduler_trigger_job runs them once', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'manual-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_upsert_job',
      jobId: 'manual-trigger-job',
      name: 'Manual Trigger Job',
      prompt: 'Run only when triggered',
      schedule_type: 'manual',
      schedule_value: 'manual',
      deliverTo: ['tg:main'],
      groupScope: 'main',
    });

    await harness.waitFor(() =>
      Boolean(harness.db.getJobById('manual-trigger-job')),
    );
    await harness.runSchedulerOnce();
    expect(harness.fakeAgent.invocations).toHaveLength(0);

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_trigger_job',
      jobId: 'manual-trigger-job',
    });
    await harness.waitFor(() =>
      Boolean(harness.db.getJobById('manual-trigger-job')?.next_run),
    );
    await harness.runSchedulerOnce();

    await harness.waitFor(() =>
      harness.db
        .getRecentJobRuns(20)
        .some(
          (run) =>
            run.job_id === 'manual-trigger-job' && run.status === 'completed',
        ),
    );
    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.db.getJobById('manual-trigger-job')?.status).toBe(
      'completed',
    );
  });

  it('releases stale scheduler leases and runs the recovered job', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'recovered-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'stale-lease-job',
      name: 'Stale Lease Job',
      prompt: 'Recover me',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });
    harness.db.updateJob('stale-lease-job', {
      status: 'running',
      lease_run_id: 'stale-run',
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    await harness.runSchedulerOnce();

    await harness.waitFor(() =>
      harness.db
        .getRecentJobRuns(20)
        .some(
          (run) =>
            run.job_id === 'stale-lease-job' && run.status === 'completed',
        ),
    );
    expect(harness.fakeAgent.invocations).toHaveLength(1);
  });

  it('preserves job ownership across pause, resume, update, and delete requests', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.db.upsertJob({
      id: 'owned-job',
      name: 'Owned Job',
      prompt: 'Original',
      schedule_type: 'manual',
      schedule_value: 'manual',
      linked_sessions: ['tg:team'],
      group_scope: 'team',
      created_by: 'agent',
      status: 'active',
      next_run: null,
    });

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_update_job',
      jobId: 'owned-job',
      prompt: 'Updated by main',
    });
    await harness.waitFor(
      () => harness.db.getJobById('owned-job')?.prompt === 'Updated by main',
    );

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_pause_job',
      jobId: 'owned-job',
    });
    await harness.waitFor(
      () => harness.db.getJobById('owned-job')?.status === 'paused',
    );

    harness.writeIpcTaskRequest('team', {
      type: 'scheduler_resume_job',
      jobId: 'owned-job',
    });
    await harness.waitFor(
      () => harness.db.getJobById('owned-job')?.status === 'active',
    );

    harness.writeIpcTaskRequest('team', {
      type: 'scheduler_update_job',
      jobId: 'owned-job',
      linkedSessions: ['tg:main'],
    });
    await harness.waitFor(
      () => harness.listIpcFiles('team', 'tasks').length === 0,
      10_000,
    );
    expect(harness.db.getJobById('owned-job')?.linked_sessions).toEqual([
      'tg:team',
    ]);

    harness.writeIpcTaskRequest('team', {
      type: 'scheduler_delete_job',
      jobId: 'owned-job',
    });
    await harness.waitFor(
      () => harness.db.getJobById('owned-job') === undefined,
    );
  }, 15_000);

  it('records scheduler retry backoff and recovers on a later successful run', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        sequence: [
          { failWithError: 'temporary scheduler failure' },
          { resultText: 'retry-success' },
        ],
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'retry-job',
      name: 'Retry Job',
      prompt: 'retry this',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
      max_retries: 2,
      retry_backoff_ms: 60_000,
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db
          .getRecentJobRuns(20)
          .some((run) => run.job_id === 'retry-job' && run.status === 'failed'),
      4_000,
    );

    const failedJob = harness.db.getJobById('retry-job');
    expect(failedJob?.status).toBe('active');
    expect(failedJob?.consecutive_failures).toBe(1);
    expect(failedJob?.lease_run_id).toBeNull();
    expect(failedJob?.lease_expires_at).toBeNull();
    expect(Date.parse(failedJob?.next_run ?? '')).toBeGreaterThan(Date.now());
    expect(
      harness.channel.outbound.some((msg) =>
        msg.text.includes('Scheduled task failed'),
      ),
    ).toBe(true);

    harness.db.updateJob('retry-job', {
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    await harness.runSchedulerOnce();

    await harness.waitFor(
      () =>
        harness.db
          .getRecentJobRuns(20)
          .some(
            (run) => run.job_id === 'retry-job' && run.status === 'completed',
          ),
      4_000,
    );

    const recoveredJob = harness.db.getJobById('retry-job');
    expect(recoveredJob?.status).toBe('completed');
    expect(recoveredJob?.consecutive_failures).toBe(0);
    expect(
      harness.db
        .getRecentJobRuns(20)
        .filter((run) => run.job_id === 'retry-job')
        .map((run) => run.status)
        .sort(),
    ).toEqual(['completed', 'failed']);
  });

  it('dead-letters terminal scheduler failures and does not run them again', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { failWithError: 'terminal scheduler failure' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'dead-letter-job',
      name: 'Dead Letter Job',
      prompt: 'fail terminally',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db.getJobById('dead-letter-job')?.status === 'dead_lettered',
      4_000,
    );

    const deadJob = harness.db.getJobById('dead-letter-job');
    expect(deadJob?.next_run).toBeNull();
    expect(deadJob?.lease_run_id).toBeNull();
    expect(deadJob?.pause_reason).toContain('terminal scheduler failure');
    expect(
      harness.db
        .getRecentJobRuns(20)
        .some(
          (run) =>
            run.job_id === 'dead-letter-job' && run.status === 'dead_lettered',
        ),
    ).toBe(true);
    expect(
      harness.db
        .listRecentJobEvents(50)
        .some(
          (event) =>
            event.job_id === 'dead-letter-job' &&
            event.event_type === 'job.failed',
        ),
    ).toBe(true);

    await harness.runSchedulerOnce();
    expect(harness.fakeAgent.invocations).toHaveLength(1);
  });

  it('does not steal unexpired scheduler leases', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'should-not-run' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'fresh-lease-job',
      name: 'Fresh Lease Job',
      prompt: 'do not steal',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });
    harness.db.updateJob('fresh-lease-job', {
      status: 'running',
      lease_run_id: 'fresh-run',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await harness.runSchedulerOnce();

    expect(harness.fakeAgent.invocations).toHaveLength(0);
    expect(harness.db.getJobById('fresh-lease-job')).toEqual(
      expect.objectContaining({
        status: 'running',
        lease_run_id: 'fresh-run',
      }),
    );
  });

  it('runs silent jobs without channel output or notification timestamps', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'silent-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'silent-job',
      name: 'Silent Job',
      prompt: 'run silently',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
      silent: true,
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () => harness.db.getJobById('silent-job')?.status === 'completed',
      4_000,
    );

    const run = harness.db
      .getRecentJobRuns(20)
      .find((item) => item.job_id === 'silent-job');
    expect(run?.status).toBe('completed');
    expect(run?.notified_at).toBeNull();
    expect(harness.channel.outbound).toHaveLength(0);
    expect(harness.channel.streaming).toHaveLength(0);
  });

  it('does not inject per-turn memory context files into scheduler runs', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'memory-context-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    for (const id of ['memory-job-a', 'memory-job-b']) {
      harness.db.upsertJob({
        id,
        name: id,
        prompt: `run ${id}`,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() - 5_000).toISOString(),
        linked_sessions: ['tg:main'],
        group_scope: 'main',
        created_by: 'agent',
        status: 'active',
        next_run: new Date(Date.now() - 5_000).toISOString(),
      });
    }

    await harness.runSchedulerOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);
    await harness.runSchedulerOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 2);

    const contextFiles = harness.fakeAgent.invocations.map(
      (invocation) => invocation.memoryContextFile,
    );
    expect(contextFiles).toHaveLength(2);
    expect(contextFiles.every((file) => file === undefined)).toBe(true);
  });

  it('keeps completed one-time jobs until delayed cleanup expires, then removes them', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'delayed-cleanup-result' },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'delayed-cleanup-job',
      name: 'Delayed Cleanup Job',
      prompt: 'run once and remain briefly',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
      cleanup_after_ms: 60_000,
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db.getJobById('delayed-cleanup-job')?.status === 'completed',
      4_000,
    );
    expect(harness.db.getJobById('delayed-cleanup-job')).toBeTruthy();

    harness.db.updateJob('delayed-cleanup-job', {
      last_run: new Date(Date.now() - 120_000).toISOString(),
    });
    await harness.runSchedulerOnce();

    expect(harness.db.getJobById('delayed-cleanup-job')).toBeUndefined();
  });

  it('does not start a second run when a schedule is mutated while the job is leased', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'mutation-run-result',
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.db.upsertJob({
      id: 'mutate-while-running',
      name: 'Mutate While Running',
      prompt: 'original running prompt',
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

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_update_job',
      jobId: 'mutate-while-running',
      prompt: 'updated while running',
      schedule_value: '*/10 * * * *',
    });
    await harness.waitFor(
      () =>
        harness.db.getJobById('mutate-while-running')?.prompt ===
        'updated while running',
    );

    await harness.runSchedulerOnce();
    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.fakeAgent.invocations[0]?.prompt).toBe(
      'original running prompt',
    );

    harness.fakeAgent.releaseAll();
    await harness.waitFor(() =>
      harness.db
        .getRecentJobRuns(20)
        .some(
          (run) =>
            run.job_id === 'mutate-while-running' && run.status === 'completed',
        ),
    );
  });

  it('completes work when one linked-session delivery fails and another succeeds', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'partial-delivery-result' },
      fakeChannel: {
        sendMessage: (jid) => {
          if (jid === 'tg:team') throw new Error('team delivery failed');
        },
        sendStreamingChunk: (jid) => {
          if (jid === 'tg:team') throw new Error('team stream failed');
        },
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.db.upsertJob({
      id: 'partial-delivery-job',
      name: 'Partial Delivery Job',
      prompt: 'run with partial delivery',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 5_000).toISOString(),
      linked_sessions: ['tg:main', 'tg:team'],
      group_scope: 'main',
      created_by: 'agent',
      status: 'active',
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db.getJobById('partial-delivery-job')?.status === 'completed',
      4_000,
    );

    const run = harness.db
      .getRecentJobRuns(20)
      .find((item) => item.job_id === 'partial-delivery-job');
    expect(run?.status).toBe('completed');
    expect(
      harness.channel.outbound.some((msg) => msg.chatJid === 'tg:main'),
    ).toBe(true);
    expect(harness.fakeAgent.invocations).toHaveLength(1);
  });
});
