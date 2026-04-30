import { describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import { jobBelongsToApp } from '@core/application/jobs/job-access.js';
import {
  assertSchedulerJobAccess,
  canAccessSchedulerJob,
  resolveLinkedSessions,
  validateSchedulerUpdate,
} from '@core/application/jobs/job-management-access.js';
import type { OpsRepository } from '@core/domain/repositories/ops-repo.js';
import type { Job, JobEvent, JobRun } from '@core/domain/types.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run',
    model: null,
    script: null,
    schedule_type: 'manual',
    schedule_value: 'manual',
    status: 'active',
    linked_sessions: ['app:app-one:conv-1'],
    session_id: null,
    thread_id: null,
    group_scope: 'app-folder',
    created_by: 'human',
    created_at: '2026-04-24T00:00:00.000Z',
    updated_at: '2026-04-24T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 0,
    timeout_ms: 300000,
    max_retries: 0,
    retry_backoff_ms: 0,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    execution_mode: 'parallel',
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

function makeOps(
  job: Job | undefined,
): Pick<OpsRepository, 'getJobById' | 'updateJob'> {
  let current = job;
  return {
    getJobById: vi.fn(async () => current),
    updateJob: vi.fn(async (_id, updates) => {
      if (current) current = { ...current, ...updates };
    }),
  };
}

function expectThrowsCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('Expected function to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('job application use cases', () => {
  it('parses app-owned job session bindings without accepting malformed IDs', () => {
    expect(jobBelongsToApp(makeJob(), 'app-one')).toBe(true);
    expect(
      jobBelongsToApp(
        makeJob({ linked_sessions: ['app:app-one:conv:extra'] }),
        'app-one',
      ),
    ).toBe(false);
    expect(
      jobBelongsToApp(
        makeJob({ linked_sessions: ['telegram:chat'] }),
        'app-one',
      ),
    ).toBe(false);
  });

  it('updates mutable job fields and requests scheduler sync', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    const result = await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: {
        name: 'Updated',
        prompt: 'New prompt',
        executionMode: 'serialized',
        threadId: 'thread-1',
        status: 'paused',
      },
    });

    expect(result.job).toMatchObject({
      name: 'Updated',
      prompt: 'New prompt',
      execution_mode: 'serialized',
      thread_id: 'thread-1',
      status: 'paused',
      pause_reason: 'Paused by SDK',
      next_run: null,
    });
    expect(ops.updateJob).toHaveBeenCalledWith('job-1', {
      name: 'Updated',
      prompt: 'New prompt',
      execution_mode: 'serialized',
      thread_id: 'thread-1',
      status: 'paused',
      pause_reason: 'Paused by SDK',
      next_run: null,
    });
    expect(scheduler.requestSchedulerSync).toHaveBeenCalledWith('job-1');
  });

  it('applies resume semantics when patching status active', async () => {
    const ops = makeOps(
      makeJob({
        schedule_type: 'interval',
        schedule_value: '900',
        status: 'paused',
        pause_reason: 'maintenance',
        next_run: null,
      }),
    );
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: { status: 'active' },
    });

    expect(ops.updateJob).toHaveBeenCalledWith('job-1', {
      status: 'active',
      pause_reason: null,
      next_run: '2026-04-24T01:00:00.000Z',
    });
    expect(scheduler.requestSchedulerSync).toHaveBeenCalledWith('job-1');
  });

  it('rejects empty mutable strings and no-ops empty patches', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await expect(
      service.updateJob({
        appId: 'app-one',
        jobId: 'job-1',
        patch: { name: '   ' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(
      service.updateJob({
        appId: 'app-one',
        jobId: 'job-1',
        patch: {},
      }),
    ).resolves.toMatchObject({ job: { id: 'job-1' } });
    expect(ops.updateJob).not.toHaveBeenCalled();
    expect(scheduler.requestSchedulerSync).not.toHaveBeenCalled();
  });

  it('computes resume next_run in the application layer', async () => {
    const ops = makeOps(
      makeJob({
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        status: 'paused',
        next_run: null,
      }),
    );
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.resumeJob({
      appId: 'app-one',
      jobId: 'job-1',
    });

    expect(ops.updateJob).toHaveBeenCalledWith('job-1', {
      status: 'active',
      pause_reason: null,
      next_run: '2026-04-24T01:00:00.000Z',
    });
  });

  it('pauses jobs without route-owned mutation logic', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.pauseJob({ appId: 'app-one', jobId: 'job-1', reason: '' }),
    ).resolves.toEqual({ paused: true });
    expect(ops.updateJob).toHaveBeenCalledWith('job-1', {
      status: 'paused',
      pause_reason: 'Paused by SDK',
      next_run: null,
    });
    expect(scheduler.requestSchedulerSync).toHaveBeenCalledWith('job-1');
  });

  it('rejects cross-app job access', async () => {
    const ops = makeOps(makeJob());
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.pauseJob({ appId: 'other-app', jobId: 'job-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('enforces scheduler access by source group, thread, and linked sessions', () => {
    const access = {
      sourceGroup: 'team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceGroupJids: ['tg:team'],
      authThreadId: 'thread-1',
    };

    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          linked_sessions: ['tg:team'],
          thread_id: 'thread-1',
        }),
        access,
      ),
    ).toBe(true);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'other',
          linked_sessions: ['tg:team'],
          thread_id: 'thread-1',
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          linked_sessions: ['tg:other'],
          thread_id: 'thread-1',
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          linked_sessions: ['tg:team'],
          thread_id: 'other-thread',
        }),
        access,
      ),
    ).toBe(false);
    expectThrowsCode(
      () =>
        assertSchedulerJobAccess(
          makeJob({
            group_scope: 'other',
            linked_sessions: ['tg:team'],
            thread_id: 'thread-1',
          }),
          access,
        ),
      'FORBIDDEN',
    );
  });

  it('validates scheduler linked sessions and thread mutations', () => {
    const access = {
      sourceGroup: 'team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceGroupJids: ['tg:team'],
      authThreadId: 'thread-1',
    };

    expect(resolveLinkedSessions({}, access)).toEqual(['tg:team']);
    expectThrowsCode(
      () => resolveLinkedSessions({ linkedSessions: ['tg:other'] }, access),
      'FORBIDDEN',
    );
    expectThrowsCode(
      () =>
        validateSchedulerUpdate(
          makeJob({ group_scope: 'team', thread_id: 'thread-1' }),
          { thread_id: 'thread-2' },
          access,
        ),
      'FORBIDDEN',
    );
  });

  it('maps IPC scheduler schedule validation to invalid_schedule', async () => {
    const ops = {
      getJobById: vi.fn(),
      upsertJob: vi.fn(),
    };
    const service = new JobManagementService({
      ops: ops as unknown as OpsRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.upsertJobFromIpc({
        access: {
          sourceGroup: 'team',
          isMain: true,
          conversationBindings: {},
          sourceGroupJids: ['tg:team'],
        },
        name: 'Bad schedule',
        prompt: 'Run',
        scheduleType: 'interval',
        scheduleValue: '0',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE' });
    expect(ops.upsertJob).not.toHaveBeenCalled();
  });

  it('rate-limits trigger requests before creating trigger rows', async () => {
    const control = {
      getAppSessionByChatJid: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        chatJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
      createJobTrigger: vi.fn(),
    };
    const service = new JobManagementService({
      ops: makeOps(makeJob()) as OpsRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: { publish: vi.fn() },
      triggerQueue: {
        isReady: () => true,
        enqueue: vi.fn(),
      },
    });

    await expect(
      service.triggerJob({
        appId: 'app-one',
        jobId: 'job-1',
        consumeRateLimit: () => false,
        perAppLimit: 1,
        perJobLimit: 1,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(control.createJobTrigger).not.toHaveBeenCalled();
  });

  it('marks a persisted trigger failed when auto-resume fails', async () => {
    const control = {
      getAppSessionByChatJid: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        chatJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
      createJobTrigger: vi.fn(async () => ({
        triggerId: 'trigger-1',
        jobId: 'job-1',
        runId: null,
        status: 'pending',
      })),
      markTriggerCompleted: vi.fn(),
    };
    const ops = makeOps(
      makeJob({
        status: 'paused',
        schedule_type: 'interval',
        schedule_value: '0',
      }),
    );
    const service = new JobManagementService({
      ops: ops as OpsRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: { publish: vi.fn() },
      triggerQueue: {
        isReady: () => true,
        enqueue: vi.fn(),
      },
    });

    await expect(
      service.triggerJob({
        appId: 'app-one',
        jobId: 'job-1',
        perAppLimit: 1,
        perJobLimit: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE' });
    expect(control.markTriggerCompleted).toHaveBeenCalledWith(
      'trigger-1',
      'failed',
    );
    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'dead_lettered',
        next_run: null,
      }),
    );
  });

  it('does not scan all jobs for scoped run and event reads', async () => {
    const run: JobRun = {
      run_id: 'run-1',
      job_id: 'job-1',
      scheduled_for: '2026-04-24T00:00:00.000Z',
      started_at: '2026-04-24T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    };
    const event: JobEvent = {
      id: 1,
      job_id: 'job-1',
      run_id: 'run-1',
      event_type: 'job.run.started',
      payload: '{}',
      created_at: '2026-04-24T00:00:00.000Z',
    };
    const ops = {
      getJobById: vi.fn(async () => makeJob()),
      getAllJobs: vi.fn(async () => []),
      listJobRuns: vi.fn(async () => [run]),
      listRecentJobEvents: vi.fn(async () => [event]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as OpsRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobRuns({ appId: 'app-one', jobId: 'job-1' }),
    ).resolves.toEqual({ runs: [run] });
    await expect(
      service.listJobEvents({ appId: 'app-one', jobId: 'job-1' }),
    ).resolves.toEqual({ events: [event] });
    expect(ops.getAllJobs).not.toHaveBeenCalled();
  });
});
