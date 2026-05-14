import { describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import { isVisibleJob } from '@core/application/jobs/job-list-filters.js';
import {
  assertSchedulerJobAccess,
  canAccessSchedulerJob,
  validateSchedulerUpdate,
} from '@core/application/jobs/job-management-access.js';
import type { JobControlPort } from '@core/application/jobs/job-management-types.js';
import type { RuntimeJobRepository } from '@core/domain/repositories/ops-repo.js';
import type { Job, JobEvent, JobRun } from '@core/domain/types.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run',
    model: null,
    schedule_type: 'manual',
    schedule_value: 'manual',
    status: 'active',
    session_id: 'session-app-one',
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

function makeControl(
  sessions: Record<string, { sessionId: string; appId: string }>,
): JobControlPort {
  return {
    getAppSessionById: vi.fn(async (sessionId: string) => {
      const session = sessions[sessionId];
      if (!session) return undefined;
      return {
        ...session,
        conversationJid: `app:${session.appId}:conversation`,
        workspaceKey: `${session.appId}-workspace`,
        defaultResponseMode: 'immediate',
        defaultWebhookId: null,
      };
    }),
    getAppSessionsByIds: vi.fn(async (sessionIds: readonly string[]) =>
      sessionIds
        .map((sessionId) => sessions[sessionId])
        .filter((session): session is { sessionId: string; appId: string } =>
          Boolean(session),
        )
        .map((session) => ({
          ...session,
          conversationJid: `app:${session.appId}:conversation`,
          workspaceKey: `${session.appId}-workspace`,
          defaultResponseMode: 'immediate',
          defaultWebhookId: null,
        })),
    ),
    getAppSessionByChatJid: vi.fn(async () => undefined),
    createJobTrigger: vi.fn(),
    markTriggerCompleted: vi.fn(),
    getTriggerById: vi.fn(),
  };
}

function makeAppOneControl(): JobControlPort {
  return makeControl({
    'session-app-one': { sessionId: 'session-app-one', appId: 'app-one' },
  });
}

describe('job application use cases', () => {
  it('persists managed app jobs with their canonical app session id', async () => {
    const upsertJob = vi.fn(async () => ({ created: true }));
    const service = new JobManagementService({
      ops: {
        upsertJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeControl({
        'session-app-one': { sessionId: 'session-app-one', appId: 'app-one' },
      }),
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => []),
      } as never,
    });

    await service.createJob({
      appId: 'app-one',
      name: 'Daily summary',
      prompt: 'Summarize activity',
      sessionId: 'session-app-one',
    });

    expect(upsertJob).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-app-one',
        group_scope: 'app-one-workspace',
      }),
    );
  });

  it('creates setup-paused jobs when declared durable requirements are missing', async () => {
    const upsertJob = vi.fn(async () => ({ created: true }));
    const runtimeEvents = { publish: vi.fn(async () => undefined) };
    const service = new JobManagementService({
      ops: {
        upsertJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeControl({
        'session-app-one': { sessionId: 'session-app-one', appId: 'app-one' },
      }),
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => []),
      } as never,
      runtimeEvents,
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    await service.createJob({
      appId: 'app-one',
      name: 'Browser summary',
      prompt: 'Summarize a web page',
      sessionId: 'session-app-one',
      requiredTools: ['Browser'],
      kind: 'recurring',
      schedule: { type: 'interval', value: '60000' },
    });

    expect(upsertJob).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        next_run: null,
        required_tools: ['Browser'],
        setup_state: expect.objectContaining({
          state: 'missing_capability',
        }),
      }),
    );
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          setup_state: 'missing_capability',
          blockers: expect.arrayContaining([
            expect.objectContaining({
              requirementType: 'browser',
              requirementId: 'Browser',
            }),
          ]),
        }),
      }),
    );
  });

  it('updates mutable job fields and requests scheduler sync', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeAppOneControl(),
      control: makeAppOneControl(),
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    const result = await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: {
        name: 'Updated',
        prompt: 'New prompt',
        threadId: 'thread-1',
        status: 'paused',
      },
    });

    expect(result.job).toMatchObject({
      name: 'Updated',
      prompt: 'New prompt',
      thread_id: 'thread-1',
      status: 'paused',
      pause_reason: 'Paused by SDK',
      next_run: null,
    });
    expect(ops.updateJob).toHaveBeenCalledWith('job-1', {
      name: 'Updated',
      prompt: 'New prompt',
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
      control: makeAppOneControl(),
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: { model: 'kimi 2.6' },
    });

    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ model: 'kimi' }),
    );

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
      control: makeAppOneControl(),
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.updateJob({
      appId: 'app-one',
      jobId: 'job-1',
      patch: { status: 'active' },
    });

    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'active',
        pause_reason: null,
        next_run: '2026-04-24T01:00:00.000Z',
      }),
    );
    expect(scheduler.requestSchedulerSync).toHaveBeenCalledWith('job-1');
  });

  it('evaluates scheduler updates against the job canonical app session', async () => {
    const ops = makeOps(
      makeJob({
        status: 'paused',
        session_id: 'session-app-one',
        group_scope: 'app-folder',
        execution_context: {
          conversationJid: 'app:app-one:conversation',
          groupScope: 'app-folder',
          threadId: null,
          sessionId: 'session-app-one',
        },
        notification_routes: [
          {
            conversationJid: 'app:app-one:conversation',
            threadId: null,
            label: 'primary',
          },
        ],
      }),
    );
    const toolRepository = {
      listAgentToolBindings: vi.fn(async ({ appId }: { appId: string }) =>
        appId === 'default'
          ? [{ status: 'active', toolId: 'browser-tool' }]
          : [],
      ),
      getTool: vi.fn(async () => ({ appId: 'default', name: 'Browser' })),
    };
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeAppOneControl(),
      toolRepository: toolRepository as never,
      getBrowserStatus: vi.fn(async () => ({ hasState: true })),
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.updateJob({
      access: {
        sourceAgentFolder: 'app-folder',
        originConversationJid: 'app:app-one:conversation',
        conversationBindings: {
          'app:app-one:conversation': { folder: 'app-folder' },
        },
      },
      jobId: 'job-1',
      patch: { status: 'active', requiredTools: ['Browser'] },
    });

    expect(toolRepository.listAgentToolBindings).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-one' }),
    );
    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        next_run: null,
        setup_state: expect.objectContaining({
          state: 'missing_capability',
        }),
      }),
    );
  });

  it('rejects empty mutable strings and no-ops empty patches', async () => {
    const ops = makeOps(makeJob());
    const scheduler = { requestSchedulerSync: vi.fn() };
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler,
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeAppOneControl(),
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
      control: makeAppOneControl(),
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.resumeJob({
      appId: 'app-one',
      jobId: 'job-1',
    });

    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'active',
        pause_reason: null,
        next_run: '2026-04-24T01:00:00.000Z',
      }),
    );
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
      control: makeAppOneControl(),
      control: makeAppOneControl(),
      clock: { now: () => '2026-04-24T01:00:00.000Z' },
    });

    await service.resumeJob({
      appId: 'app-one',
      jobId: 'job-1',
    });

    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'active',
        pause_reason: null,
        next_run: '2026-04-24T01:00:00.000Z',
      }),
    );
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
      control: makeAppOneControl(),
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
      control: makeAppOneControl(),
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
      control: makeAppOneControl(),
    });

    await expect(
      service.pauseJob({ appId: 'other-app', jobId: 'job-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('rejects PATCH executionContext retargeting to another app session', async () => {
    const ops = makeOps(makeJob({ thread_id: 'thread-1' }));
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeControl({
        'session-app-one': { sessionId: 'session-app-one', appId: 'app-one' },
        'session-app-two': { sessionId: 'session-app-two', appId: 'app-two' },
      }),
    });

    await expect(
      service.updateJob({
        appId: 'app-one',
        jobId: 'job-1',
        patch: {
          executionContext: {
            conversationJid: 'app:app-two:conversation',
            threadId: null,
            groupScope: 'app-two-workspace',
            sessionId: 'session-app-two',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('uses canonical session ownership instead of linked session strings for app access', async () => {
    const job = makeJob({
      session_id: 'session-app-two',
    });
    const ops = makeOps(job);
    const service = new JobManagementService({
      ops: ops as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeControl({
        'session-app-two': { sessionId: 'session-app-two', appId: 'app-two' },
      }),
    });

    await expect(
      service.pauseJob({ appId: 'app-one', jobId: 'job-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('filters app job lists by canonical session ownership', async () => {
    const appOneJob = makeJob({
      id: 'job-app-one',
      session_id: 'session-app-one',
    });
    const staleLinkedJob = makeJob({
      id: 'job-stale-linked',
      session_id: 'session-app-two',
    });
    const ops = {
      listJobs: vi.fn(async () => [appOneJob, staleLinkedJob]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeControl({
        'session-app-one': { sessionId: 'session-app-one', appId: 'app-one' },
        'session-app-two': { sessionId: 'session-app-two', appId: 'app-two' },
      }),
    });

    await expect(service.listJobs({ appId: 'app-one' })).resolves.toEqual({
      jobs: [appOneJob],
    });
  });

  it('hides app jobs without canonical session ownership', async () => {
    const missingSessionJob = makeJob({
      id: 'job-missing-session',
      session_id: null,
    });
    const malformedAppJob = makeJob({
      id: 'job-malformed-app',
      session_id: null,
    });
    const crossAppJob = makeJob({
      id: 'job-cross-app',
      session_id: null,
    });
    const ops = {
      listJobs: vi.fn(async () => [
        missingSessionJob,
        malformedAppJob,
        crossAppJob,
      ]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeControl({}),
    });

    await expect(service.listJobs({ appId: 'app-one' })).resolves.toEqual({
      jobs: [],
    });
  });

  it('lets the default local control key inspect host-owned scheduler jobs', async () => {
    const hostOwnedJob = makeJob({
      id: 'host-owned-job',
      session_id: null,
      group_scope: 'main_agent',
      created_by: 'agent',
      execution_context: {
        conversationJid: 'tg:-1003986348737',
        threadId: null,
        groupScope: 'main_agent',
      },
    });
    const appOwnedJob = makeJob({
      id: 'app-owned-job',
      session_id: 'session-app-one',
    });
    const ops = {
      listJobs: vi.fn(async () => [hostOwnedJob, appOwnedJob]),
      getJobById: vi.fn(async (jobId: string) =>
        jobId === hostOwnedJob.id ? hostOwnedJob : appOwnedJob,
      ),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeAppOneControl(),
    });

    await expect(service.listJobs({ appId: 'default' })).resolves.toEqual({
      jobs: [hostOwnedJob],
    });
    await expect(
      service.getJob({ appId: 'default', jobId: hostOwnedJob.id }),
    ).resolves.toEqual({ job: hostOwnedJob });
    await expect(service.listJobs({ appId: 'app-one' })).resolves.toEqual({
      jobs: [appOwnedJob],
    });
    await expect(
      service.getJob({ appId: 'app-one', jobId: hostOwnedJob.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces scheduler access by source group and canonical execution context', () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
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
          execution_context: {
            conversationJid: 'tg:team',
            threadId: 'thread-1',
            groupScope: 'team',
          },
        }),
        access,
      ),
    ).toBe(true);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'other',
          execution_context: {
            conversationJid: 'tg:team',
            threadId: 'thread-1',
            groupScope: 'other',
          },
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          execution_context: {
            conversationJid: 'tg:other',
            threadId: 'thread-1',
            groupScope: 'team',
          },
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          execution_context: {
            conversationJid: 'tg:team',
            threadId: 'other-thread',
            groupScope: 'team',
          },
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          thread_id: 'other-thread',
          execution_context: {
            conversationJid: 'tg:team',
            threadId: null,
            groupScope: 'team',
          },
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          notification_routes: [
            {
              conversationJid: 'tg:sibling',
              threadId: 'thread-1',
              label: 'sibling',
            },
          ],
        }),
        access,
      ),
    ).toBe(false);
    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          notification_routes: [
            {
              conversationJid: 'tg:sibling',
              threadId: 'thread-1',
              label: 'sibling',
            },
            {
              conversationJid: 'tg:team',
              threadId: 'thread-1',
              label: 'primary',
            },
          ],
        }),
        access,
      ),
    ).toBe(true);
    expectThrowsCode(
      () =>
        assertSchedulerJobAccess(
          makeJob({
            group_scope: 'other',
            execution_context: {
              conversationJid: 'tg:team',
              threadId: 'thread-1',
              groupScope: 'other',
            },
          }),
          access,
        ),
      'FORBIDDEN',
    );
  });

  it('uses execution context rather than legacy linked-session membership', () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceAgentFolderJids: ['tg:team'],
    };

    expect(
      canAccessSchedulerJob(
        makeJob({
          group_scope: 'team',
          execution_context: {
            conversationJid: 'tg:team',
            threadId: null,
            groupScope: 'team',
          },
        }),
        access,
      ),
    ).toBe(true);
  });

  it('validates scheduler thread mutations', () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      conversationBindings: {
        'tg:team': { folder: 'team' },
        'tg:sibling': { folder: 'team' },
        'tg:other': { folder: 'other' },
      },
      sourceAgentFolderJids: ['tg:team', 'tg:sibling'],
      authThreadId: 'thread-1',
    };

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
      control: makeAppOneControl(),
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
      agentId: 'agent:one',
      kind: 'recurring',
      conversationJid: 'tg:team',
      limit: 500,
    });
  });

  it('pushes scheduler access group scope into the bounded repository query', async () => {
    const ops = {
      listJobs: vi.fn(async () => []),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeAppOneControl(),
    });

    await service.listJobs({
      access: {
        sourceAgentFolder: 'team',
        originConversationJid: 'tg:team',
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
        conversationJid: undefined,
        limit: 100,
      }),
    );
    expect(ops.listJobs.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
  });

  it('lists threaded jobs that the same caller can get by id', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      conversationBindings: {
        'tg:team': { folder: 'team' },
      },
      sourceConversationJids: ['tg:team'],
      authThreadId: '2771',
    };
    const threadedJob = makeJob({
      id: 'lead:knacklabs-controller',
      group_scope: 'team',
      thread_id: '2771',
      execution_context: {
        conversationJid: 'tg:team',
        threadId: '2771',
        groupScope: 'team',
      },
    });
    const ops = {
      getJobById: vi.fn(async () => threadedJob),
      listJobs: vi.fn(async (filters?: { threadId?: string | null }) =>
        filters && Object.prototype.hasOwnProperty.call(filters, 'threadId')
          ? []
          : [threadedJob],
      ),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: makeAppOneControl(),
    });

    await expect(
      service.getJob({ jobId: threadedJob.id, access }),
    ).resolves.toEqual({ job: threadedJob });
    await expect(service.listJobs({ access })).resolves.toEqual({
      jobs: [threadedJob],
    });

    expect(ops.listJobs.mock.calls[0]?.[0]).not.toHaveProperty('threadId');
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
      control: makeAppOneControl(),
    });

    await expect(
      service.upsertJobFromIpc({
        access: {
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
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
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
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
      ops: makeOps(
        makeJob({ session_id: 'session-1' }),
      ) as RuntimeJobRepository,
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

  it('resolves trigger sessions through canonical session ids', async () => {
    const control = {
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'webhook',
        defaultWebhookId: 'webhook-1',
      })),
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
          session_id: 'session-1',
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

    expect(control.getAppSessionById).toHaveBeenCalledWith('session-1');
    expect(control.getAppSessionsByChatJids).not.toHaveBeenCalled();
    expect(control.getAppSessionByChatJid).not.toHaveBeenCalled();
    expect(triggerQueue.enqueue).toHaveBeenCalledWith('job-1', 'trigger-1');
  });

  it('rejects paused external job triggers without resuming scheduler state', async () => {
    const control = {
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
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
        session_id: 'session-1',
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
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'Cannot trigger job while status is paused; resume the job explicitly first.',
    });
    expect(control.createJobTrigger).not.toHaveBeenCalled();
    expect(control.markTriggerCompleted).not.toHaveBeenCalled();
    expect(ops.updateJob).not.toHaveBeenCalled();
  });

  it('authorizes external triggers from canonical session_id without linked app JIDs', async () => {
    const control = {
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
      getAppSessionByChatJid: vi.fn(),
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
          session_id: 'session-1',
        }),
      ) as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: control as never,
      runtimeEvents: { publish: vi.fn() },
      triggerQueue,
    });

    await expect(
      service.triggerJob({
        appId: 'app-one',
        jobId: 'job-1',
        perAppLimit: 1,
        perJobLimit: 1,
      }),
    ).resolves.toEqual({ triggerId: 'trigger-1' });
    expect(control.getAppSessionById).toHaveBeenCalledWith('session-1');
    expect(control.getAppSessionByChatJid).not.toHaveBeenCalled();
    expect(triggerQueue.enqueue).toHaveBeenCalledWith('job-1', 'trigger-1');
  });

  it('checks per-job trigger quota before app trigger quota', async () => {
    const control = {
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
      getAppSessionByChatJid: vi.fn(),
      createJobTrigger: vi.fn(),
    };
    const consumeRateLimit = vi.fn((key: string) => {
      return !key.includes(':job:');
    });
    const service = new JobManagementService({
      ops: makeOps(
        makeJob({
          session_id: 'session-1',
        }),
      ) as RuntimeJobRepository,
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
        consumeRateLimit,
        perAppLimit: 5,
        perJobLimit: 2,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(consumeRateLimit).toHaveBeenCalledWith('app:app-one:job:job-1', 2);
    expect(control.createJobTrigger).not.toHaveBeenCalled();
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
      control: makeAppOneControl(),
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
      owner_app_id: undefined,
      job_id: 'job-1',
      job_ids: undefined,
      run_id: undefined,
      event_type: undefined,
      since_id: 123,
      since: '2026-04-24T00:00:00.000Z',
    });
  });

  it('rejects unknown scheduler event filters before querying events', async () => {
    const ops = {
      listRecentJobEvents: vi.fn(async () => []),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(
      service.listJobEvents({
        appId: 'app-one',
        eventType: 'runtime.unknown',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Unknown runtime event type "runtime.unknown".',
    });
    expect(ops.listRecentJobEvents).not.toHaveBeenCalled();
  });

  it('uses repository app ownership filters for app-scoped run and event pages', async () => {
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
      service.listJobRuns({ appId: 'app-one', limit: 10 }),
    ).resolves.toEqual({ runs: [run] });
    await expect(
      service.listJobEvents({ appId: 'app-one', limit: 20 }),
    ).resolves.toEqual({ events: [event] });

    expect(ops.listJobs).not.toHaveBeenCalled();
    expect(ops.listJobRuns).toHaveBeenCalledWith(undefined, 10, {
      jobIds: undefined,
      ownerAppId: 'app-one',
    });
    expect(ops.listRecentJobEvents).toHaveBeenCalledWith(20, {
      app_id: undefined,
      owner_app_id: 'app-one',
      job_id: undefined,
      job_ids: undefined,
      run_id: undefined,
      event_type: undefined,
      since_id: undefined,
      since: undefined,
    });
  });

  it('does not query persisted run or event rows for missing scoped job ids', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
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

  it('rejects scoped run reads when execution context conversation differs', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
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
          execution_context: {
            conversationJid: 'tg:sibling',
            threadId: null,
            groupScope: 'team',
          },
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
      execution_context: {
        conversationJid: 'tg:team',
        threadId: null,
        groupScope: 'team',
      },
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
        conversationJid: undefined,
      }),
    );
    expect(ops.listJobRuns).toHaveBeenCalledWith(undefined, 10, {
      jobIds: ['job-1'],
      ownerAppId: undefined,
    });
    expect(ops.listRecentJobEvents).toHaveBeenCalledWith(20, {
      app_id: undefined,
      owner_app_id: undefined,
      job_id: undefined,
      job_ids: ['job-1'],
      run_id: 'run-1',
      event_type: undefined,
      since_id: undefined,
      since: undefined,
    });
  });

  it('returns empty scoped run and event lists when no jobs are visible', async () => {
    const access = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:team',
      conversationBindings: {
        'tg:team': { folder: 'team' },
      },
      sourceAgentFolderJids: ['tg:team'],
    };
    const ops = {
      listJobs: vi.fn(async () => []),
      listJobRuns: vi.fn(async () => [
        {
          run_id: 'run-leaked',
          job_id: 'other-job',
          scheduled_for: '2026-04-24T00:00:00.000Z',
          started_at: '2026-04-24T00:00:00.000Z',
          ended_at: null,
          status: 'running',
          result_summary: null,
          error_summary: null,
          retry_count: 0,
          notified_at: null,
        },
      ]),
      listRecentJobEvents: vi.fn(async () => [
        {
          id: 1,
          job_id: 'other-job',
          run_id: 'run-leaked',
          event_type: 'job.run.started',
          payload: '{}',
          created_at: '2026-04-24T00:00:00.000Z',
        },
      ]),
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    await expect(service.listJobRuns({ access, limit: 10 })).resolves.toEqual({
      runs: [],
    });
    await expect(service.listJobEvents({ access, limit: 10 })).resolves.toEqual(
      { events: [] },
    );

    expect(ops.listJobs).toHaveBeenCalledTimes(2);
    expect(ops.listJobRuns).not.toHaveBeenCalled();
    expect(ops.listRecentJobEvents).not.toHaveBeenCalled();
  });

  it('queues scheduler_run_now with a preallocated run id for the real job', async () => {
    const control = {
      createJobTrigger: vi.fn(async () => ({ triggerId: 'trigger-1' })),
      markTriggerCompleted: vi.fn(),
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'app-one-workspace',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
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
          session_id: 'session-1',
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
        appId: 'app-one',
        sessionId: 'session-1',
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

  it('queues scheduler_run_now without runtime event projection for channel-only jobs', async () => {
    const control = {
      createJobTrigger: vi.fn(async () => ({ triggerId: 'trigger-1' })),
      markTriggerCompleted: vi.fn(),
      getAppSessionById: vi.fn(),
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
          session_id: null,
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

    expect(triggerQueue.enqueue).toHaveBeenCalledWith('job-1', 'trigger-1', {
      runId: 'run-1',
    });
    expect(runtimeEvents.publish).not.toHaveBeenCalled();
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
      getAppSessionById: vi.fn(async () => undefined),
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
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-1',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        workspaceKey: 'team',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
      })),
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
      getJobById: vi.fn(async () => makeJob({ session_id: 'session-1' })),
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
});
