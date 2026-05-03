import { describe, expect, it, beforeEach, vi } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import type { TaskContext, TaskIpcData } from '@core/jobs/ipc-types.js';

const mocks = vi.hoisted(() => ({
  responder: {
    accept: vi.fn(),
    reject: vi.fn(),
  },
  jobService: {
    upsertJobFromIpc: vi.fn(),
    updateJob: vi.fn(),
    resumeJob: vi.fn(),
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
  JobManagementService: vi.fn(function JobManagementService() {
    return mocks.jobService;
  }),
}));

import { schedulerCreateTaskHandlers } from '@core/jobs/ipc-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from '@core/jobs/ipc-scheduler-mutate-handlers.js';

function makeContext(data: TaskIpcData): TaskContext {
  return {
    data: {
      type: data.type,
      taskId: 'task-1',
      ...data,
    },
    sourceGroup: 'team',
    isMain: false,
    registeredGroups: {},
    sourceGroupJids: ['tg:team'],
    deps: {
      opsRepository: {
        getJobById: vi.fn(),
      },
      onSchedulerChanged: vi.fn(),
    },
  } as unknown as TaskContext;
}

describe('scheduler IPC adapter contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
