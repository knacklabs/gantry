import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import type { TaskContext, TaskIpcData } from '@core/jobs/ipc-types.js';
import { schedulerJobConfirmationToken } from '@core/shared/scheduler-job-plan.js';

const mocks = vi.hoisted(() => ({
  responder: {
    accept: vi.fn(),
    acceptData: vi.fn(),
    reject: vi.fn(),
  },
  jobService: {
    upsertJobFromIpc: vi.fn(),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    runJobNowFromMcp: vi.fn(),
    listJobEvents: vi.fn(),
  },
  jobServiceDeps: [] as unknown[],
  runtimeControlRepository: {
    getAppSessionById: vi.fn(),
    getAppSessionsByIds: vi.fn(),
    getAppSessionByChatJid: vi.fn(),
    getAppSessionsByChatJids: vi.fn(),
    createJobTrigger: vi.fn(),
    markTriggerCompleted: vi.fn(),
    getTriggerById: vi.fn(),
  },
}));

vi.mock('@core/jobs/ipc-shared.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/jobs/ipc-shared.js')
  >('@core/jobs/ipc-shared.js');
  return {
    ...actual,
    createTaskResponder: vi.fn(() => mocks.responder),
  };
});

vi.mock('@core/application/jobs/job-management-service.js', () => ({
  JobManagementService: vi.fn(function JobManagementService(deps: unknown) {
    mocks.jobServiceDeps.push(deps);
    return mocks.jobService;
  }),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeEventExchange: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

import { schedulerCreateTaskHandlers } from '@core/jobs/ipc-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from '@core/jobs/ipc-scheduler-mutate-handlers.js';
import { schedulerQueryTaskHandlers } from '@core/jobs/ipc-scheduler-query-handlers.js';
import { schedulerAccessFromContext } from '@core/jobs/ipc-scheduler-access.js';

function adaptAppSession(session: any) {
  if (!session) return undefined;
  return {
    ...session,
    conversationJid: session.conversationJid ?? session.chatJid,
  };
}

function makeContext(data: TaskIpcData): TaskContext {
  return {
    data: {
      type: data.type,
      taskId: 'task-1',
      chatJid: 'tg:team',
      targetJid: 'tg:team',
      ...data,
    },
    sourceAgentFolder: 'team',
    conversationBindings: {
      'tg:team': { folder: 'team' },
      'tg:team-a': { folder: 'team' },
      'tg:team-b': { folder: 'team' },
    },
    sourceAgentFolderJids: ['tg:team'],
    deps: {
      opsRepository: {
        getJobById: vi.fn(),
      },
      onSchedulerChanged: vi.fn(),
      requestPermissionApproval: vi.fn(async () => ({
        approved: true,
      })),
      getJobControl: () => ({
        getAppSessionById: async (sessionId: string) =>
          adaptAppSession(
            await mocks.runtimeControlRepository.getAppSessionById(sessionId),
          ),
        getAppSessionsByIds: async (sessionIds: readonly string[]) =>
          (
            await mocks.runtimeControlRepository.getAppSessionsByIds(sessionIds)
          ).map(adaptAppSession),
        getAppSessionByChatJid: async (chatJid: string) =>
          adaptAppSession(
            await mocks.runtimeControlRepository.getAppSessionByChatJid(
              chatJid,
            ),
          ),
        getAppSessionsByChatJids: async (chatJids: readonly string[]) =>
          (
            await mocks.runtimeControlRepository.getAppSessionsByChatJids(
              chatJids,
            )
          ).map(adaptAppSession),
        createJobTrigger: mocks.runtimeControlRepository.createJobTrigger,
        markTriggerCompleted:
          mocks.runtimeControlRepository.markTriggerCompleted,
        getTriggerById: mocks.runtimeControlRepository.getTriggerById,
      }),
    },
  } as unknown as TaskContext;
}

describe('scheduler IPC adapter contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobServiceDeps.length = 0;
    mocks.runtimeControlRepository.getAppSessionById.mockResolvedValue(
      undefined,
    );
    mocks.runtimeControlRepository.getAppSessionsByIds.mockResolvedValue([]);
    mocks.runtimeControlRepository.getAppSessionByChatJid.mockResolvedValue(
      undefined,
    );
    mocks.runtimeControlRepository.getAppSessionsByChatJids.mockResolvedValue(
      [],
    );
    mocks.runtimeControlRepository.createJobTrigger.mockResolvedValue({
      triggerId: 'trigger-1',
      jobId: 'job-1',
      runId: null,
      status: 'pending',
    });
    mocks.runtimeControlRepository.markTriggerCompleted.mockResolvedValue(
      undefined,
    );
    mocks.runtimeControlRepository.getTriggerById.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps missing upsert scheduleType as invalid_request', async () => {
    await schedulerCreateTaskHandlers.scheduler_upsert_job(
      makeContext({
        type: 'scheduler_upsert_job',
        name: 'Daily review',
        prompt: 'Review memory',
        scheduleValue: '60000',
      }),
    );

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'scheduler_upsert_job requires scheduleType.',
      'invalid_request',
    );
    expect(mocks.jobService.upsertJobFromIpc).not.toHaveBeenCalled();
  });

  it('fails loudly when scheduler IPC context omits conversation bindings', () => {
    const context = makeContext({ type: 'scheduler_list_jobs' });
    delete (context as Partial<TaskContext>).conversationBindings;

    expect(() => schedulerAccessFromContext(context)).toThrow(
      'Scheduler IPC context missing conversation bindings.',
    );
  });

  it('keeps unsupported upsert scheduleType as invalid_schedule', async () => {
    await schedulerCreateTaskHandlers.scheduler_upsert_job(
      makeContext({
        type: 'scheduler_upsert_job',
        name: 'Daily review',
        prompt: 'Review memory',
        scheduleType: 'manual',
        scheduleValue: '60000',
      }),
    );

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'Unsupported schedule type.',
      'invalid_schedule',
    );
    expect(mocks.jobService.upsertJobFromIpc).not.toHaveBeenCalled();
  });

  it('describes job runtime context after scheduler upsert', async () => {
    mocks.jobService.upsertJobFromIpc.mockResolvedValueOnce({
      jobId: 'job-1',
      created: true,
      modelAlias: null,
    });

    await schedulerCreateTaskHandlers.scheduler_upsert_job(
      makeContext({
        type: 'scheduler_upsert_job',
        name: 'Daily review',
        prompt: 'Review memory',
        scheduleType: 'once',
        scheduleValue: '2026-05-04T00:00:00.000Z',
        confirm: true,
        confirmationToken: schedulerJobConfirmationToken({
          name: 'Daily review',
          prompt: 'Review memory',
          scheduleType: 'once',
          scheduleValue: '2026-05-04T00:00:00.000Z',
        }),
      }),
    );

    const message = mocks.responder.accept.mock.calls[0][0] as string;
    expect(message).toContain('Scheduler job created (job-1).');
    expect(message).toContain('Model:');
    expect(message).toContain('Notifications: this conversation.');
    expect(message).not.toContain('Runtime:');
    expect(message).not.toContain('browser');
    expect(message).not.toContain('cache:');
  });

  it('returns a scheduler upsert plan without creating when confirmation is omitted', async () => {
    await schedulerCreateTaskHandlers.scheduler_upsert_job(
      makeContext({
        type: 'scheduler_upsert_job',
        name: 'Daily review',
        prompt: 'Review memory',
        scheduleType: 'once',
        scheduleValue: '2026-05-04T00:00:00.000Z',
      }),
    );

    expect(mocks.jobService.upsertJobFromIpc).not.toHaveBeenCalled();
    expect(mocks.responder.acceptData).toHaveBeenCalledWith(
      expect.stringContaining('Scheduler job plan'),
      expect.objectContaining({
        type: 'scheduler_job_plan',
        confirmationToken: expect.any(String),
      }),
      'confirmation_required',
    );
  });

  it('passes canonical scheduler upsert target context through to the job service', async () => {
    mocks.jobService.upsertJobFromIpc.mockResolvedValueOnce({
      jobId: 'job-1',
      created: true,
      modelAlias: null,
    });

    await schedulerCreateTaskHandlers.scheduler_upsert_job(
      makeContext({
        type: 'scheduler_upsert_job',
        name: 'Daily review',
        prompt: 'Review memory',
        scheduleType: 'once',
        scheduleValue: '2026-05-04T00:00:00.000Z',
        confirm: true,
        executionContext: {
          conversationJid: 'tg:team',
          threadId: null,
          workspaceKey: 'team',
        },
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: null,
            label: 'primary',
          },
        ],
        accessRequirements: [
          {
            target: {
              kind: 'capability',
              capabilityId: 'acme.records.append',
              implementation: {
                kind: 'local_cli',
                name: 'acme',
                executablePath: '/usr/local/bin/acme',
                commandTemplate: '/usr/local/bin/acme records append *',
              },
            },
            reason: 'Write lead rows after each run',
          },
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
        confirmationToken: schedulerJobConfirmationToken({
          name: 'Daily review',
          prompt: 'Review memory',
          scheduleType: 'once',
          scheduleValue: '2026-05-04T00:00:00.000Z',
          executionContext: {
            conversationJid: 'tg:team',
            threadId: null,
            workspaceKey: 'team',
          },
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: null,
              label: 'primary',
            },
          ],
          accessRequirements: [
            {
              target: {
                kind: 'capability',
                capabilityId: 'acme.records.append',
                implementation: {
                  kind: 'local_cli',
                  name: 'acme',
                  executablePath: '/usr/local/bin/acme',
                  commandTemplate: '/usr/local/bin/acme records append *',
                },
              },
              reason: 'Write lead rows after each run',
            },
            { target: { kind: 'tool_rule', rule: 'Browser' } },
          ],
        }),
      }),
    );

    expect(mocks.jobService.upsertJobFromIpc).toHaveBeenCalledWith(
      expect.objectContaining({
        executionContext: {
          conversationJid: 'tg:team',
          threadId: null,
          workspaceKey: 'team',
        },
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: null,
            label: 'primary',
          },
        ],
        accessRequirements: [
          {
            target: {
              kind: 'capability',
              capabilityId: 'acme.records.append',
              implementation: {
                kind: 'local_cli',
                name: 'acme',
                executablePath: '/usr/local/bin/acme',
                commandTemplate: '/usr/local/bin/acme records append *',
              },
            },
            reason: 'Write lead rows after each run',
          },
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
      }),
    );
  });

  it('injects canonical app session control for app-origin scheduler upserts', async () => {
    mocks.runtimeControlRepository.getAppSessionByChatJid.mockResolvedValueOnce(
      {
        sessionId: 'sess-app-one',
        appId: 'app-one',
        conversationId: 'conv-1',
        chatJid: 'app:app-one:conv-1',
        workspaceKey: 'workspace-1',
        title: 'App One',
        defaultResponseMode: 'webhook',
        defaultWebhookId: 'webhook-1',
      },
    );
    mocks.jobService.upsertJobFromIpc.mockResolvedValueOnce({
      jobId: 'job-1',
      created: true,
      modelAlias: null,
    });
    const context = makeContext({
      type: 'scheduler_upsert_job',
      name: 'Daily review',
      prompt: 'Review memory',
      scheduleType: 'once',
      scheduleValue: '2026-05-04T00:00:00.000Z',
      confirm: true,
      confirmationToken: schedulerJobConfirmationToken({
        name: 'Daily review',
        prompt: 'Review memory',
        scheduleType: 'once',
        scheduleValue: '2026-05-04T00:00:00.000Z',
      }),
      chatJid: 'app:app-one:conv-1',
      targetJid: 'app:app-one:conv-1',
    });
    context.sourceAgentFolderJids = ['app:app-one:conv-1'];
    context.conversationBindings = {
      'app:app-one:conv-1': {
        folder: 'team',
        name: 'App One',
        conversationKind: 'group',
      },
    };

    await schedulerCreateTaskHandlers.scheduler_upsert_job(context);

    const deps = mocks.jobServiceDeps.at(-1) as {
      control?: {
        getAppSessionByChatJid: (chatJid: string) => Promise<unknown>;
      };
    };
    expect(deps.control).toBeDefined();
    await expect(
      deps.control?.getAppSessionByChatJid('app:app-one:conv-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionId: 'sess-app-one',
        appId: 'app-one',
        conversationJid: 'app:app-one:conv-1',
        defaultWebhookId: 'webhook-1',
      }),
    );
    expect(mocks.jobService.upsertJobFromIpc).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          originConversationJid: 'app:app-one:conv-1',
        }),
      }),
    );
  });

  it('resolves scheduler update models through catalog aliases', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        modelAlias: 'kimi 2.6',
      }),
    );

    expect(mocks.jobService.updateJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      patch: { model: 'kimi-2.6' },
    });
    expect(mocks.responder.accept).toHaveBeenCalledWith(
      'Scheduler job updated (job-1).',
    );
  });

  it('passes scheduler update accessRequirements through to the job service', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        accessRequirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
      }),
    );

    expect(mocks.jobService.updateJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      patch: {
        accessRequirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
      },
    });
  });

  it('clears scheduler update models with null alias', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        modelAlias: null,
      }),
    );

    expect(mocks.jobService.updateJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      patch: { model: null },
    });
    expect(mocks.responder.accept).toHaveBeenCalledWith(
      'Scheduler job updated (job-1).',
    );
  });

  it('rejects raw provider IDs for scheduler update models', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        modelAlias: 'moonshotai/kimi-k2.6',
      }),
    );

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'Provider model ID "moonshotai/kimi-k2.6" is not accepted here. Use a model alias from /models.',
      'invalid_model',
    );
    expect(mocks.jobService.updateJob).not.toHaveBeenCalled();
  });

  it('ignores removed scheduler update model profile selectors before submit', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        modelProfileId: 'openrouter:kimi-k2.6',
      }),
    );

    expect(mocks.jobService.updateJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      patch: {},
    });
  });

  it('preserves dead-letter resume details when the pause reason is available', async () => {
    const pauseReason =
      'Cannot resume with invalid schedule configuration (cron:not-cron).';
    const context = makeContext({
      type: 'scheduler_resume_job',
      jobId: 'job-1',
    });
    vi.mocked(context.deps.opsRepository.getJobById).mockResolvedValue({
      id: 'job-1',
      status: 'dead_lettered',
      pause_reason: pauseReason,
    } as never);
    mocks.jobService.resumeJob.mockRejectedValueOnce(
      new ApplicationError(
        'INVALID_SCHEDULE',
        'Cannot resume scheduler job due to invalid schedule.',
      ),
    );

    await schedulerMutateTaskHandlers.scheduler_resume_job(context);

    expect(mocks.jobService.resumeJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      invalidSchedulePolicy: 'dead_letter',
    });
    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'Cannot resume scheduler job due to invalid schedule.',
      'invalid_schedule',
      [pauseReason, 'Job has been moved to dead_lettered state.'],
    );
  });

  it('queues scheduler_run_now through the job service with conversation access', async () => {
    mocks.jobService.runJobNowFromMcp.mockResolvedValueOnce({
      runId: 'run-1',
      queued: true,
      triggerId: 'trigger-1',
    });

    await schedulerMutateTaskHandlers.scheduler_run_now(
      makeContext({
        type: 'scheduler_run_now',
        jobId: 'job-1',
      }),
    );

    expect(mocks.jobService.runJobNowFromMcp).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.objectContaining({
        sourceAgentFolder: 'team',
        originConversationJid: 'tg:team',
      }),
      runId: expect.any(String),
    });
    expect(mocks.responder.acceptData).toHaveBeenCalledWith(
      'Scheduler job queued (job-1).',
      {
        run_id: 'run-1',
        queued: true,
        trigger_id: 'trigger-1',
      },
    );
  });

  it('rejects scheduler_run_now without a job id', async () => {
    await schedulerMutateTaskHandlers.scheduler_run_now(
      makeContext({
        type: 'scheduler_run_now',
      }),
    );

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'scheduler_run_now requires jobId.',
      'invalid_request',
    );
    expect(mocks.jobService.runJobNowFromMcp).not.toHaveBeenCalled();
  });

  it('waits for scheduler events until a matching event arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.jobService.listJobEvents
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({
        events: [{ id: 3, job_id: 'job-1', event_type: 'run_started' }],
      });

    const waitPromise = schedulerQueryTaskHandlers.scheduler_wait_for_events(
      makeContext({
        type: 'scheduler_wait_for_events',
        jobId: 'job-1',
        eventType: 'run_started',
        timeoutMs: 5_000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await waitPromise;

    expect(Date.now()).toBe(2_000);
    expect(mocks.jobService.listJobEvents).toHaveBeenCalledTimes(3);
    expect(mocks.responder.acceptData).toHaveBeenCalledWith(
      'Listed 1 scheduler event(s).',
      {
        events: [{ id: 3, job_id: 'job-1', event_type: 'run_started' }],
      },
    );
  });

  it('does not return an empty scheduler event wait before the requested timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.jobService.listJobEvents.mockResolvedValue({ events: [] });

    const waitPromise = schedulerQueryTaskHandlers.scheduler_wait_for_events(
      makeContext({
        type: 'scheduler_wait_for_events',
        jobId: 'job-1',
        timeoutMs: 2_500,
      }),
    );

    await vi.advanceTimersByTimeAsync(2_499);
    expect(mocks.responder.acceptData).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await waitPromise;

    expect(Date.now()).toBe(2_500);
    expect(mocks.jobService.listJobEvents).toHaveBeenCalledTimes(4);
    expect(mocks.responder.acceptData).toHaveBeenCalledWith(
      'Listed 0 scheduler event(s).',
      { events: [] },
    );
  });

  it('lists scheduler notification targets from the authenticated conversation scope', async () => {
    const context = makeContext({
      type: 'scheduler_list_notification_targets',
      chatJid: 'tg:team',
    });
    context.conversationBindings = {
      'tg:team': {
        folder: 'team',
        name: 'Team Channel',
        conversationKind: 'channel',
      },
      'tg:dm-user': {
        folder: 'team',
        name: 'Direct Chat',
        conversationKind: 'dm',
      },
    };
    context.sourceAgentFolderJids = ['tg:team', 'tg:dm-user'];

    await schedulerQueryTaskHandlers.scheduler_list_notification_targets(
      context,
    );

    expect(mocks.responder.acceptData).toHaveBeenCalledWith(
      expect.stringContaining('Listed'),
      expect.objectContaining({
        targets: expect.arrayContaining([
          expect.objectContaining({ shortcut: 'here' }),
        ]),
      }),
    );
    const targets = mocks.responder.acceptData.mock.calls[0]?.[1]?.targets as
      | Array<Record<string, unknown>>
      | undefined;
    expect(targets?.some((target) => target.shortcut === 'me_dm')).toBe(false);
    expect(
      targets?.some((target) => target.kind === 'bound_conversation'),
    ).toBe(false);
  });

  it('shows me_dm shortcut only when origin conversation is a DM', async () => {
    const context = makeContext({
      type: 'scheduler_list_notification_targets',
      chatJid: 'tg:dm-user',
    });
    context.conversationBindings = {
      'tg:team': {
        folder: 'team',
        name: 'Team Channel',
        conversationKind: 'channel',
      },
      'tg:dm-user': {
        folder: 'team',
        name: 'Direct Chat',
        conversationKind: 'dm',
      },
    };
    context.sourceAgentFolderJids = ['tg:team', 'tg:dm-user'];

    await schedulerQueryTaskHandlers.scheduler_list_notification_targets(
      context,
    );

    const targets = mocks.responder.acceptData.mock.calls[0]?.[1]?.targets as
      | Array<Record<string, unknown>>
      | undefined;
    expect(targets).toEqual(
      expect.arrayContaining([expect.objectContaining({ shortcut: 'me_dm' })]),
    );
    const dmTarget = targets?.find((target) => target.shortcut === 'me_dm');
    expect(dmTarget).toMatchObject({
      executionContext: {
        conversationJid: 'tg:dm-user',
      },
      notificationRoutes: [
        {
          conversationJid: 'tg:dm-user',
          threadId: null,
          label: 'me_dm',
        },
      ],
    });
  });
});
