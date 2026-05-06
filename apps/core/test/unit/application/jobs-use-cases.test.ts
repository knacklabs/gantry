import { describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import { jobBelongsToApp } from '@core/application/jobs/job-access.js';
import { isVisibleJob } from '@core/application/jobs/job-list-filters.js';
import {
  assertSchedulerJobAccess,
  canAccessSchedulerJob,
  resolveLinkedSessions,
  validateSchedulerUpdate,
} from '@core/application/jobs/job-management-access.js';
import type { RuntimeJobRepository } from '@core/domain/repositories/ops-repo.js';
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
): Pick<RuntimeJobRepository, 'getJobById' | 'updateJob'> {
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
    expect(
      jobBelongsToApp(
        makeJob({
          linked_sessions: ['app:app-one:conv', 'app:app-two:conv'],
        }),
        'app-one',
      ),
    ).toBe(false);
  });

  it('updates mutable job fields and requests scheduler sync', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
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

  it('validates job model updates through catalog aliases', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: { model: 'kimi 2.6' },
    });

    expect(ops.updateJob).toHaveBeenCalledWith('job-1', { model: 'kimi' });

    await expect(
      service.updateJob({
        appId: 'app-one',
        jobId: 'job-1',
        patch: { model: 'moonshotai/kimi-k2.6' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message:
        'Provider model ID "moonshotai/kimi-k2.6" is not accepted here. Use a model alias from /models.',
    });
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
      ops: ops as RuntimeJobRepository,
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
      ops: ops as RuntimeJobRepository,
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
      ops: ops as RuntimeJobRepository,
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

  it('uses resume-now semantics for invalid schedules unless dead-letter is requested', async () => {
    const ops = makeOps(
      makeJob({
        schedule_type: 'interval',
        schedule_value: '0',
        status: 'paused',
        next_run: null,
      }),
    );
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
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

  it('dead-letters invalid schedules for scheduler-controlled resume', async () => {
    const ops = makeOps(
      makeJob({
        schedule_type: 'interval',
        schedule_value: '0',
        status: 'paused',
        next_run: null,
      }),
    );
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await expect(
      service.resumeJob({
        appId: 'app-one',
        jobId: 'job-1',
        invalidSchedulePolicy: 'dead_letter',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SCHEDULE',
      details: [
        'Cannot resume with invalid schedule configuration (interval:0).',
        'Job has been moved to dead_lettered state.',
      ],
    });

    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'dead_lettered',
        next_run: null,
      }),
    );
  });

  it('pauses jobs without route-owned mutation logic', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
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
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.pauseJob({ appId: 'other-app', jobId: 'job-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('enforces scheduler access by source group and originating conversation', () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:sibling': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceAgentFolderJids: ['tg:team', 'tg:sibling'],
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
    ).toBe(true);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          linked_sessions: ['tg:sibling'],
          thread_id: 'thread-1',
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          linked_sessions: ['tg:team', 'tg:sibling'],
          thread_id: 'thread-1',
        }),
        access,
      ),
    ).toBe(true);
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
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:sibling': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceAgentFolderJids: ['tg:team', 'tg:sibling'],
      authThreadId: 'thread-1',
    };

    expect(resolveLinkedSessions({}, access)).toEqual(['tg:team']);
    expect(
      resolveLinkedSessions(
        { linkedSessions: ['tg:team', 'tg:sibling'] },
        access,
      ),
    ).toEqual(['tg:team', 'tg:sibling']);
    expectThrowsCode(
      () => resolveLinkedSessions({ linkedSessions: ['tg:other'] }, access),
      'FORBIDDEN',
    );
    expectThrowsCode(
      () => resolveLinkedSessions({ linkedSessions: ['tg:sibling'] }, access),
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
    expect(() =>
      validateSchedulerUpdate(
        makeJob({ group_scope: 'team', thread_id: 'thread-1' }),
        { thread_id: null },
        access,
      ),
    ).not.toThrow();
  });

  it('filters jobs by normalized agent id for plain and canonical group scopes', () => {
    expect(
      isVisibleJob(makeJob({ group_scope: 'one' }), {
        agentId: 'agent:one',
      }),
    ).toBe(true);
    expect(
      isVisibleJob(makeJob({ group_scope: 'agent:one' }), {
        agentId: 'agent:one',
      }),
    ).toBe(true);
    expect(
      isVisibleJob(makeJob({ group_scope: 'agent:two' }), {
        agentId: 'agent:one',
      }),
    ).toBe(false);
  });

  it('pushes job list filters and bounded limits into the repository query', async () => {
    const ops = {
      listJobs: vi.fn(async () => [makeJob({ id: 'job-1' })]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobs({
        appId: 'app-one',
        agentId: 'agent:one',
        kind: 'recurring',
        conversationJid: 'tg:team',
        statuses: ['active'],
        limit: 900,
      }),
    ).resolves.toEqual({ jobs: [] });

    expect(ops.listJobs).toHaveBeenCalledWith({
      appId: 'app-one',
      statuses: ['active'],
      groupScope: undefined,
      threadId: undefined,
      agentId: 'agent:one',
      kind: 'recurring',
      conversationJid: 'tg:team',
      limit: 500,
    });
  });

  it('pushes non-main linked-session access into the bounded repository query', async () => {
    const ops = {
      listJobs: vi.fn(async () => []),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await service.listJobs({
      access: {
        sourceAgentFolder: 'team',
        originConversationJid: 'tg:team',
        isMain: false,
        conversationBindings: {
          'tg:team': { folder: 'team' },
          'tg:other': { folder: 'other' },
        },
        sourceAgentFolderJids: ['tg:team'],
      },
    });

    expect(ops.listJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        groupScope: 'team',
        conversationJid: 'tg:team',
        limit: 100,
      }),
    );
  });

  it('maps IPC scheduler schedule validation to invalid_schedule', async () => {
    const ops = {
      getJobById: vi.fn(),
      upsertJob: vi.fn(),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.upsertJobFromIpc({
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
          isMain: true,
          conversationBindings: {},
          sourceAgentFolderJids: ['tg:team'],
        },
        name: 'Bad schedule',
        prompt: 'Run',
        scheduleType: 'interval',
        scheduleValue: '0',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE' });
    expect(ops.upsertJob).not.toHaveBeenCalled();
  });

  it('rejects ambiguous IPC scheduler model selectors', async () => {
    const ops = {
      getJobById: vi.fn(),
      upsertJob: vi.fn(),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.upsertJobFromIpc({
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
          isMain: true,
          conversationBindings: {},
          sourceAgentFolderJids: ['tg:team'],
        },
        name: 'Ambiguous model',
        prompt: 'Run',
        modelAlias: 'kimi',
        modelProfileId: 'openrouter:kimi-k2.6',
        scheduleType: 'once',
        scheduleValue: '2026-05-01T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Use either modelAlias or modelProfileId, not both.',
    });
    expect(ops.upsertJob).not.toHaveBeenCalled();
  });

  it('rejects IPC scheduler upsert thread ids without authenticated thread context', async () => {
    const ops = {
      getJobById: vi.fn(),
      upsertJob: vi.fn(),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.upsertJobFromIpc({
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
          isMain: false,
          conversationBindings: {
            'tg:team': { folder: 'team' },
          },
          sourceAgentFolderJids: ['tg:team'],
        },
        name: 'Spoofed thread',
        prompt: 'Run',
        scheduleType: 'interval',
        scheduleValue: '60000',
        threadId: 'thread-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
      ops: makeOps(makeJob()) as RuntimeJobRepository,
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

  it('resolves trigger sessions with the batch control lookup when available', async () => {
    const control = {
      getAppSessionByChatJid: vi.fn(),
      getAppSessionsByChatJids: vi.fn(async () => [
        {
          sessionId: 'session-1',
          appId: 'app-one',
          chatJid: 'app:app-one:conv-1',
          workspaceKey: 'team',
          defaultResponseMode: 'webhook',
          defaultWebhookId: 'webhook-1',
        },
      ]),
      createJobTrigger: vi.fn(async () => ({
        triggerId: 'trigger-1',
        jobId: 'job-1',
        runId: null,
        status: 'pending',
      })),
      markTriggerCompleted: vi.fn(),
    };
    const triggerQueue = {
      isReady: () => true,
      enqueue: vi.fn(),
    };
    const service = new JobManagementService({
      ops: makeOps(
        makeJob({
          linked_sessions: ['telegram:chat', 'app:app-one:conv-1'],
        }),
      ) as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: { publish: vi.fn() },
      triggerQueue,
    });

    await service.triggerJob({
      appId: 'app-one',
      jobId: 'job-1',
      perAppLimit: 1,
      perJobLimit: 1,
    });

    expect(control.getAppSessionsByChatJids).toHaveBeenCalledWith([
      'app:app-one:conv-1',
    ]);
    expect(control.getAppSessionByChatJid).not.toHaveBeenCalled();
    expect(triggerQueue.enqueue).toHaveBeenCalledWith('job-1', 'trigger-1');
  });

  it('auto-resumes paused jobs with invalid schedules when triggered externally', async () => {
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
      ops: ops as RuntimeJobRepository,
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
    ).resolves.toEqual({ triggerId: 'trigger-1' });
    expect(control.markTriggerCompleted).not.toHaveBeenCalled();
    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'active',
        pause_reason: null,
        next_run: expect.any(String),
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
      listJobs: vi.fn(async () => []),
      listJobRuns: vi.fn(async () => [run]),
      listRecentJobEvents: vi.fn(async () => [event]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobRuns({ appId: 'app-one', jobId: 'job-1' }),
    ).resolves.toEqual({ runs: [run] });
    await expect(
      service.listJobEvents({
        appId: 'app-one',
        jobId: 'job-1',
        sinceId: 123,
        since: '2026-04-24T00:00:00.000Z',
      }),
    ).resolves.toEqual({ events: [event] });
    expect(ops.getAllJobs).not.toHaveBeenCalled();
    expect(ops.listRecentJobEvents).toHaveBeenCalledWith(200, {
      app_id: undefined,
      job_id: 'job-1',
      job_ids: undefined,
      run_id: undefined,
      event_type: undefined,
      since_id: 123,
      since: '2026-04-24T00:00:00.000Z',
    });
  });

  it('does not query persisted run or event rows for missing scoped job ids', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
      },
      sourceAgentFolderJids: ['tg:team'],
    };
    const leakedRun: JobRun = {
      run_id: 'run-leaked',
      job_id: 'deleted-job',
      scheduled_for: '2026-04-24T00:00:00.000Z',
      started_at: '2026-04-24T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    };
    const leakedEvent: JobEvent = {
      id: 1,
      job_id: 'deleted-job',
      run_id: 'run-leaked',
      event_type: 'job.run.started',
      payload: '{}',
      created_at: '2026-04-24T00:00:00.000Z',
    };
    const ops = {
      getJobById: vi.fn(async () => undefined),
      listJobRuns: vi.fn(async () => [leakedRun]),
      listRecentJobEvents: vi.fn(async () => [leakedEvent]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobRuns({ access, jobId: 'deleted-job' }),
    ).resolves.toEqual({ runs: [] });
    await expect(
      service.listJobEvents({ access, jobId: 'deleted-job' }),
    ).resolves.toEqual({ events: [] });

    expect(ops.getJobById).toHaveBeenCalledTimes(2);
    expect(ops.listJobRuns).not.toHaveBeenCalled();
    expect(ops.listRecentJobEvents).not.toHaveBeenCalled();
  });

  it('rejects inaccessible scoped run and event reads before querying persisted rows', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceAgentFolderJids: ['tg:team'],
    };
    const ops = {
      getJobById: vi.fn(async () =>
        makeJob({
          id: 'other-job',
          group_scope: 'other',
          linked_sessions: ['tg:other'],
        }),
      ),
      listJobRuns: vi.fn(async () => []),
      listRecentJobEvents: vi.fn(async () => []),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobRuns({ access, jobId: 'other-job' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.listJobEvents({ access, jobId: 'other-job' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(ops.getJobById).toHaveBeenCalledTimes(2);
    expect(ops.listJobRuns).not.toHaveBeenCalled();
    expect(ops.listRecentJobEvents).not.toHaveBeenCalled();
  });

  it('rejects scoped run reads when the originating conversation is not linked', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:sibling': { folder: 'team' },
      },
      sourceAgentFolderJids: ['tg:team', 'tg:sibling'],
    };
    const ops = {
      getJobById: vi.fn(async () =>
        makeJob({
          id: 'sibling-job',
          group_scope: 'team',
          linked_sessions: ['tg:sibling'],
        }),
      ),
      listJobRuns: vi.fn(async () => []),
      listRecentJobEvents: vi.fn(async () => []),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobRuns({ access, jobId: 'sibling-job' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.listJobEvents({ access, jobId: 'sibling-job' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(ops.listJobRuns).not.toHaveBeenCalled();
    expect(ops.listRecentJobEvents).not.toHaveBeenCalled();
  });

  it('derives visible MCP job ids before listing runs, events, and dead letters', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      isMain: false,
      conversationBindings: {
        'tg:team': { folder: 'team' },
      },
      sourceAgentFolderJids: ['tg:team'],
    };
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
    const visibleJob = makeJob({
      id: 'job-1',
      group_scope: 'team',
      linked_sessions: ['tg:team'],
    });
    const ops = {
      listJobs: vi.fn(async () => [visibleJob]),
      listJobRuns: vi.fn(async () => [run]),
      listRecentJobEvents: vi.fn(async () => [event]),
      listDeadLetterRuns: vi.fn(async () => [run]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(service.listJobRuns({ access, limit: 10 })).resolves.toEqual({
      runs: [run],
    });
    await expect(
      service.listJobEvents({
        access,
        runId: 'run-1',
        limit: 20,
      }),
    ).resolves.toEqual({ events: [event] });
    await expect(
      service.listDeadLetterRuns({ access, limit: 5 }),
    ).resolves.toEqual({ deadLetterRuns: [run] });

    expect(ops.listJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        groupScope: 'team',
        conversationJid: 'tg:team',
      }),
    );
    expect(ops.listJobRuns).toHaveBeenCalledWith(undefined, 10, {
      jobIds: ['job-1'],
    });
    expect(ops.listRecentJobEvents).toHaveBeenCalledWith(20, {
      app_id: undefined,
      job_id: undefined,
      job_ids: ['job-1'],
      run_id: 'run-1',
      event_type: undefined,
      since_id: undefined,
      since: undefined,
    });
  });

  it('queues scheduler_run_now with a preallocated run id for the real job', async () => {
    const control = {
      createJobTrigger: vi.fn(async () => ({ triggerId: 'trigger-1' })),
      markTriggerCompleted: vi.fn(),
    };
    const runtimeEvents = { publish: vi.fn() };
    const triggerQueue = {
      isReady: vi.fn(() => true),
      enqueue: vi.fn(async () => undefined),
    };
    const service = new JobManagementService({
      ops: makeOps(
        makeJob({
          id: 'job-1',
          group_scope: 'team',
          linked_sessions: ['tg:team'],
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
        }),
      ) as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents,
      triggerQueue,
    });

    await expect(
      service.runJobNowFromMcp({
        jobId: 'job-1',
        runId: 'run-1',
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
          isMain: false,
          conversationBindings: {
            'tg:team': { folder: 'team' },
          },
          sourceAgentFolderJids: ['tg:team'],
        },
      }),
    ).resolves.toEqual({
      runId: 'run-1',
      queued: true,
      triggerId: 'trigger-1',
    });

    expect(control.createJobTrigger).toHaveBeenCalledWith({
      jobId: 'job-1',
      requestedBy: JSON.stringify({
        kind: 'mcp',
        sourceAgentFolder: 'team',
        conversationJid: 'tg:team',
      }),
    });
    expect(triggerQueue.enqueue).toHaveBeenCalledWith('job-1', 'trigger-1', {
      runId: 'run-1',
    });
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        runId: 'run-1',
        triggerId: 'trigger-1',
        payload: expect.objectContaining({
          runId: 'run-1',
          triggeredBy: 'mcp',
        }),
      }),
    );
  });

  it('rejects scheduler_run_now for inactive jobs before enqueueing', async () => {
    const control = {
      createJobTrigger: vi.fn(),
      markTriggerCompleted: vi.fn(),
    };
    const triggerQueue = {
      isReady: vi.fn(() => true),
      enqueue: vi.fn(),
    };
    const service = new JobManagementService({
      ops: makeOps(
        makeJob({
          status: 'paused',
          group_scope: 'team',
          linked_sessions: ['tg:team'],
        }),
      ) as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: { publish: vi.fn() },
      triggerQueue,
    });

    await expect(
      service.runJobNowFromMcp({
        jobId: 'job-1',
        runId: 'run-1',
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
          isMain: false,
          conversationBindings: {
            'tg:team': { folder: 'team' },
          },
          sourceAgentFolderJids: ['tg:team'],
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(control.createJobTrigger).not.toHaveBeenCalled();
    expect(triggerQueue.enqueue).not.toHaveBeenCalled();
  });

  it('marks scheduler_run_now triggers failed when enqueue fails', async () => {
    const control = {
      createJobTrigger: vi.fn(async () => ({ triggerId: 'trigger-1' })),
      markTriggerCompleted: vi.fn(),
    };
    const triggerQueue = {
      isReady: vi.fn(() => true),
      enqueue: vi.fn(async () => {
        throw new Error('pg-boss insert failed');
      }),
    };
    const service = new JobManagementService({
      ops: makeOps(
        makeJob({
          group_scope: 'team',
          linked_sessions: ['tg:team'],
        }),
      ) as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: { publish: vi.fn() },
      triggerQueue,
    });

    await expect(
      service.runJobNowFromMcp({
        jobId: 'job-1',
        runId: 'run-1',
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
          isMain: false,
          conversationBindings: {
            'tg:team': { folder: 'team' },
          },
          sourceAgentFolderJids: ['tg:team'],
        },
      }),
    ).rejects.toMatchObject({
      code: 'ENQUEUE_FAILED',
      message: 'pg-boss insert failed',
    });

    expect(control.markTriggerCompleted).toHaveBeenCalledWith(
      'trigger-1',
      'failed',
    );
  });

  it('waits for trigger completion through runtime event wakeups', async () => {
    const subscription = {
      next: vi.fn(async () => [{ eventId: 1 }]),
      close: vi.fn(),
    };
    const control = {
      getTriggerById: vi
        .fn()
        .mockResolvedValueOnce({
          triggerId: 'trigger-1',
          jobId: 'job-1',
          runId: null,
          status: 'pending',
        })
        .mockResolvedValueOnce({
          triggerId: 'trigger-1',
          jobId: 'job-1',
          runId: null,
          status: 'pending',
        })
        .mockResolvedValue({
          triggerId: 'trigger-1',
          jobId: 'job-1',
          runId: 'run-1',
          status: 'completed',
        }),
    };
    const ops = {
      getJobById: vi.fn(async () => makeJob()),
      getJobRunById: vi.fn(async () => ({
        run_id: 'run-1',
        job_id: 'job-1',
        scheduled_for: '2026-04-24T00:00:00.000Z',
        started_at: '2026-04-24T00:00:00.000Z',
        ended_at: '2026-04-24T00:00:01.000Z',
        status: 'completed',
        result_summary: 'done',
        error_summary: null,
        retry_count: 0,
        notified_at: null,
      })),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: {
        publish: vi.fn(),
        subscribe: vi.fn(() => subscription),
      },
    });

    await expect(
      service.waitForTrigger({
        appId: 'app-one',
        triggerId: 'trigger-1',
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({
      triggerId: 'trigger-1',
      runId: 'run-1',
      status: 'completed',
      resultSummary: 'done',
    });
    expect(subscription.next).toHaveBeenCalled();
    expect(subscription.close).toHaveBeenCalled();
  });

  it('does not request approval when job extras are already inherited by the target agent', async () => {
    const ops = makeOps(makeJob());
    const approveJobExtraTools = vi.fn(async () => ({ approved: true }));
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => [
          {
            toolId: 'tool:Read',
            status: 'active',
          },
        ]),
      } as never,
      approveJobExtraTools,
    });

    await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: { allowedTools: ['Read'] },
    });

    expect(approveJobExtraTools).not.toHaveBeenCalled();
    expect(ops.updateJob).toHaveBeenCalledWith('job-1', {
      capability_policy: { allowed_tools: ['Read'] },
    });
  });

  it('does not request approval when an IPC upsert preserves already approved job extras', async () => {
    const ops = {
      getJobById: vi.fn(async () =>
        makeJob({ capability_policy: { allowed_tools: ['Bash'] } }),
      ),
      upsertJob: vi.fn(async () => ({ created: false })),
    };
    const approveJobExtraTools = vi.fn(async () => ({ approved: true }));
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => []),
      } as never,
      approveJobExtraTools,
    });

    await service.upsertJobFromIpc({
      access: {
        sourceAgentFolder: 'app-folder',
        originConversationJid: 'app:app-one:conv-1',
        isMain: true,
        conversationBindings: {
          'app:app-one:conv-1': { folder: 'app-folder' },
        },
        sourceAgentFolderJids: ['app:app-one:conv-1'],
      },
      jobId: 'job-1',
      name: 'Job',
      prompt: 'Run',
      scheduleType: 'interval',
      scheduleValue: '60000',
      groupScope: 'app-folder',
    });

    expect(approveJobExtraTools).not.toHaveBeenCalled();
    expect(ops.upsertJob).toHaveBeenCalledWith(
      expect.objectContaining({
        capability_policy: { allowed_tools: ['Bash'] },
      }),
    );
  });

  it('denies job extra tool updates before mutating the existing job', async () => {
    const ops = makeOps(makeJob({ capability_policy: { allowed_tools: [] } }));
    const approveJobExtraTools = vi.fn(async () => ({
      approved: false,
      reason: 'no',
    }));
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => [
          {
            toolId: 'tool:Read',
            status: 'active',
          },
        ]),
      } as never,
      approveJobExtraTools,
    });

    await expect(
      service.updateJob({
        appId: 'app-one',
        jobId: 'job-1',
        patch: { allowedTools: ['Bash'] },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(approveJobExtraTools).toHaveBeenCalledWith(
      expect.objectContaining({
        extrasBeyondInherited: ['Bash'],
        existingJobExtraTools: [],
      }),
    );
    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('fails closed when extra tools need approval but no approval port is configured', async () => {
    const ops = makeOps(makeJob({ capability_policy: { allowed_tools: [] } }));
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => []),
      } as never,
    });

    await expect(
      service.updateJob({
        appId: 'app-one',
        jobId: 'job-1',
        patch: { allowedTools: ['Bash'] },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('rejects broad MyClaw MCP wildcards for non-main job extras', async () => {
    const ops = makeOps(makeJob({ capability_policy: { allowed_tools: [] } }));
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.updateJob({
        access: {
          sourceAgentFolder: 'app-folder',
          originConversationJid: 'app:app-one:conv-1',
          isMain: false,
          conversationBindings: {
            'app:app-one:conv-1': { folder: 'app-folder' },
          },
          sourceAgentFolderJids: ['app:app-one:conv-1'],
        },
        jobId: 'job-1',
        patch: { allowedTools: ['mcp__myclaw__*'] },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
