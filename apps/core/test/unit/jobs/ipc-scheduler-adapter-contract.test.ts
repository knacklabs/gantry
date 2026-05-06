import { describe, expect, it, beforeEach, vi } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import type { TaskContext, TaskIpcData } from '@core/jobs/ipc-types.js';

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
  },
  jobServiceDeps: [] as unknown[],
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
  getRuntimeControlRepository: vi.fn(() => ({})),
  getRuntimeEventExchange: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

import { schedulerCreateTaskHandlers } from '@core/jobs/ipc-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from '@core/jobs/ipc-scheduler-mutate-handlers.js';
import { schedulerAccessFromContext } from '@core/jobs/ipc-scheduler-access.js';

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
    isMain: false,
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
    },
  } as unknown as TaskContext;
}

describe('scheduler IPC adapter contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobServiceDeps.length = 0;
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
      }),
    );

    const message = mocks.responder.accept.mock.calls[0][0] as string;
    expect(message).toContain('Scheduler job created (job-1).');
    expect(message).toContain('Model:');
    expect(message).toContain('Runtime: notifications this conversation');
    expect(message).toContain('team conversation browser');
  });

  it('passes scheduler upsert allowedTools through to the job service', async () => {
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
        allowedTools: ['Read'],
      }),
    );

    expect(mocks.jobService.upsertJobFromIpc).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ['Read'],
        access: expect.objectContaining({
          sourceAgentFolder: 'team',
          originConversationJid: 'tg:team',
        }),
      }),
    );
  });

  it('routes scheduler create job tool approvals to the originating conversation', async () => {
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
      allowedTools: ['Read'],
      chatJid: 'tg:team-b',
      targetJid: 'tg:team-b',
    });
    context.sourceAgentFolderJids = ['tg:team-a', 'tg:team-b'];

    await schedulerCreateTaskHandlers.scheduler_upsert_job(context);

    const deps = mocks.jobServiceDeps.at(-1) as {
      approveJobExtraTools: (request: unknown) => Promise<{
        approved: boolean;
        reason?: string;
      }>;
    };
    await deps.approveJobExtraTools({
      operation: 'create',
      jobName: 'Daily review',
      target: { agentId: 'team' },
      inheritedTools: [],
      existingJobExtraTools: [],
      requestedJobExtraTools: ['Read'],
      extrasBeyondInherited: ['Read'],
    });

    expect(context.deps.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'tg:team-b',
      }),
    );
  });

  it('fails closed for scheduler create without an originating conversation', async () => {
    const context = makeContext({
      type: 'scheduler_upsert_job',
      name: 'Daily review',
      prompt: 'Review memory',
      scheduleType: 'once',
      scheduleValue: '2026-05-04T00:00:00.000Z',
      allowedTools: ['Read'],
      chatJid: undefined,
    });
    context.sourceAgentFolderJids = ['tg:team-a', 'tg:team-b'];

    await schedulerCreateTaskHandlers.scheduler_upsert_job(context);

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'Scheduler job operations require an originating conversation.',
      'forbidden',
    );
    expect(mocks.jobService.upsertJobFromIpc).not.toHaveBeenCalled();
    expect(context.deps.requestPermissionApproval).not.toHaveBeenCalled();
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
      patch: { model: 'kimi' },
    });
    expect(mocks.responder.accept).toHaveBeenCalledWith(
      'Scheduler job updated (job-1).',
    );
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

  it('passes scheduler update allowedTools replacements and clears through to the job service', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        allowedTools: [],
      }),
    );

    expect(mocks.jobService.updateJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      patch: { allowedTools: [] },
    });

    vi.clearAllMocks();
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        allowedTools: ['Read'],
      }),
    );

    expect(mocks.jobService.updateJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      access: expect.any(Object),
      patch: { allowedTools: ['Read'] },
    });
  });

  it('routes scheduler update job tool approvals to the originating conversation', async () => {
    const context = makeContext({
      type: 'scheduler_update_job',
      jobId: 'job-1',
      allowedTools: ['Read'],
      chatJid: 'tg:team-b',
      targetJid: 'tg:team-b',
    });
    context.sourceAgentFolderJids = ['tg:team-a', 'tg:team-b'];

    await schedulerMutateTaskHandlers.scheduler_update_job(context);

    const deps = mocks.jobServiceDeps.at(-1) as {
      approveJobExtraTools: (request: unknown) => Promise<{
        approved: boolean;
        reason?: string;
      }>;
    };
    await deps.approveJobExtraTools({
      operation: 'update',
      jobId: 'job-1',
      jobName: 'Daily review',
      target: { agentId: 'team' },
      inheritedTools: [],
      existingJobExtraTools: [],
      requestedJobExtraTools: ['Read'],
      extrasBeyondInherited: ['Read'],
    });

    expect(context.deps.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'tg:team-b',
      }),
    );
  });

  it('fails closed for scheduler update job tool approval target overrides', async () => {
    const context = makeContext({
      type: 'scheduler_update_job',
      jobId: 'job-1',
      allowedTools: ['Read'],
      chatJid: 'tg:team-b',
      targetJid: 'tg:team-a',
    });
    context.sourceAgentFolderJids = ['tg:team-a', 'tg:team-b'];

    await schedulerMutateTaskHandlers.scheduler_update_job(context);

    const deps = mocks.jobServiceDeps.at(-1) as {
      approveJobExtraTools: (request: unknown) => Promise<{
        approved: boolean;
        reason?: string;
      }>;
    };
    const decision = await deps.approveJobExtraTools({
      operation: 'update',
      jobId: 'job-1',
      jobName: 'Daily review',
      target: { agentId: 'team' },
      inheritedTools: [],
      existingJobExtraTools: [],
      requestedJobExtraTools: ['Read'],
      extrasBeyondInherited: ['Read'],
    });

    expect(decision).toEqual({
      approved: false,
      reason:
        'scheduler job tool approval must use the originating chat as the approval target',
    });
    expect(context.deps.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('uses explicit job-scoped approval options for durable extra tool storage', async () => {
    const context = makeContext({
      type: 'scheduler_upsert_job',
      name: 'Daily review',
      prompt: 'Review memory',
      scheduleType: 'interval',
      scheduleValue: '60000',
      allowedTools: ['Read'],
    });

    await schedulerCreateTaskHandlers.scheduler_upsert_job(context);
    const deps = mocks.jobServiceDeps.at(-1) as {
      approveJobExtraTools: (request: unknown) => Promise<{
        approved: boolean;
        reason?: string;
      }>;
    };
    await deps.approveJobExtraTools({
      operation: 'create',
      jobId: 'job-1',
      jobName: 'Daily review',
      target: { agentId: 'team' },
      inheritedTools: [],
      existingJobExtraTools: [],
      requestedJobExtraTools: ['Read'],
      extrasBeyondInherited: ['Read'],
    });

    expect(context.deps.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionOptions: ['allow_job_policy', 'cancel'],
        toolInput: expect.objectContaining({
          persistence: 'target_json.capabilityPolicy.allowedTools',
        }),
      }),
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

  it('rejects conflicting scheduler update model selectors', async () => {
    await schedulerMutateTaskHandlers.scheduler_update_job(
      makeContext({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        modelAlias: 'kimi',
        modelProfileId: 'openrouter:kimi-k2.6',
      }),
    );

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'Use either modelAlias or modelProfileId, not both.',
      'invalid_model',
    );
    expect(mocks.jobService.updateJob).not.toHaveBeenCalled();
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
});
