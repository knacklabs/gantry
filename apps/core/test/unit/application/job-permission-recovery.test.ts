import { describe, expect, it, vi } from 'vitest';

import { recheckSetupPausedJobsAfterCapabilityUpdate } from '@core/application/jobs/job-permission-recovery.js';
import {
  configureSetupPausePermissionPrompt,
  setupPausePermissionRequestId,
} from '@core/application/jobs/setup-pause-permission-prompt.js';
import { permissionRecoveryNotificationRunId } from '@core/jobs/execution-notifications.js';
import { notifyJobSetupRequired } from '@core/jobs/execution-readiness.js';
import type { Job } from '@core/domain/types.js';
import type {
  JobListFilters,
  RuntimeJobRepository,
} from '@core/domain/repositories/ops-repo.js';

function pausedJob(index: number): Job {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `job-${suffix}`,
    name: `Paused job ${suffix}`,
    prompt: 'Run the job',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'paused',
    session_id: null,
    thread_id: `thread-${suffix}`,
    workspace_key: 'team',
    created_by: 'human',
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 0,
    timeout_ms: 30_000,
    max_retries: 0,
    retry_backoff_ms: 0,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: 'Setup required',
    execution_context: {
      conversationJid: `tg:team-${suffix}`,
      threadId: `thread-${suffix}`,
      workspaceKey: 'team',
    },
    notification_routes: [
      {
        conversationJid: `tg:team-${suffix}`,
        threadId: `thread-${suffix}`,
        label: 'Primary',
      },
    ],
    setup_state: {
      state: 'missing_capability',
      checked_at: '2026-08-06T00:00:00.000Z',
      fingerprint: `blocked-${suffix}`,
      blockers: [],
    },
  };
}

describe('permission recovery', () => {
  it('drains past 100 paused jobs and sends a route-scoped receipt per resumed job', async () => {
    const jobs = Array.from({ length: 150 }, (_, index) => pausedJob(index));
    const listJobs = vi.fn(async (filters?: JobListFilters) =>
      jobs
        .filter((job) => job.status === 'paused')
        .filter((job) => !filters?.pageAfter || job.id < filters.pageAfter.id)
        .sort((left, right) => right.id.localeCompare(left.id))
        .slice(0, filters?.limit),
    );
    const updateJob = vi.fn(async (id: string, updates: Partial<Job>) => {
      const job = jobs.find((candidate) => candidate.id === id);
      if (job) Object.assign(job, updates);
    });
    const resumeSetupPausedJob = vi.fn(async (input) => {
      const job = jobs.find((candidate) => candidate.id === input.jobId);
      if (
        !job ||
        job.status !== 'paused' ||
        job.pause_reason !== input.expectedPauseReason ||
        job.setup_state?.checked_at !== input.expectedSetupCheckedAt
      ) {
        return false;
      }
      Object.assign(job, {
        status: 'active',
        pause_reason: null,
        next_run: input.nextRun,
        setup_state: input.setupState,
        lease_run_id: null,
        lease_expires_at: null,
      });
      return true;
    });
    const sendQueuedReceipt = vi.fn(async (job: Job) => {
      expect(job.notification_routes).toEqual([
        {
          conversationJid: `tg:team-${job.id.slice(-3)}`,
          threadId: `thread-${job.id.slice(-3)}`,
          label: 'Primary',
        },
      ]);
      if (job.id === 'job-075') throw new Error('provider unavailable');
    });

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      opsRepository: {
        listJobs,
        getJobById: vi.fn(),
        updateJob,
        resumeSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      sendQueuedReceipt,
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(result.checked).toBe(150);
    expect(result.queued).toHaveLength(150);
    expect(result.stillBlocked).toEqual([]);
    expect(listJobs).toHaveBeenCalledTimes(2);
    expect(listJobs.mock.calls[1]?.[0]?.pageAfter).toEqual({
      createdAt: '2026-08-06T00:00:00.000Z',
      id: 'job-050',
    });
    expect(sendQueuedReceipt).toHaveBeenCalledTimes(150);
    expect(jobs.every((job) => job.status === 'active')).toBe(true);
  });

  it('emits the queued receipt before requesting scheduler sync', async () => {
    const job = pausedJob(1);
    const order: string[] = [];

    await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        updateJob: vi.fn(async (_id, updates) => Object.assign(job, updates)),
        resumeSetupPausedJob: vi.fn(async (input) => {
          Object.assign(job, {
            status: 'active',
            setup_state: input.setupState,
          });
          return true;
        }),
      } as unknown as RuntimeJobRepository,
      scheduler: {
        requestSchedulerSync: vi.fn(() => order.push('sync')),
      },
      sendQueuedReceipt: vi.fn(async () => {
        order.push('receipt');
      }),
      publishRuntimeEvent: vi.fn(async () => {
        order.push('event');
      }),
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(order).toEqual(['receipt', 'event', 'sync']);
  });

  it('retires the recovered setup prompt after a cross-flow atomic resume', async () => {
    const job = pausedJob(1);
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
    configureSetupPausePermissionPrompt({
      appId: 'default',
      cancelPermissionApproval,
    } as never);

    try {
      await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        recoveringPermissionRequestId: 'request-access:another-flow',
        opsRepository: {
          getJobById: vi.fn(async () => job),
          resumeSetupPausedJob: vi.fn(async () => true),
        } as unknown as RuntimeJobRepository,
        scheduler: { requestSchedulerSync: vi.fn() },
        clock: { now: () => '2026-08-06T00:05:00.000Z' },
      });

      expect(cancelPermissionApproval).toHaveBeenCalledWith({
        requestId: setupPausePermissionRequestId(
          job.id,
          job.setup_state!.fingerprint,
        ),
        appId: 'default',
        sourceAgentFolder: job.workspace_key,
        reason: 'The job setup requirement was resolved by another grant.',
      });
    } finally {
      configureSetupPausePermissionPrompt(null);
    }
  });

  it('does not cancel the setup prompt interaction performing the recovery', async () => {
    const job = pausedJob(1);
    const requestId = setupPausePermissionRequestId(
      job.id,
      job.setup_state!.fingerprint,
    );
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
    configureSetupPausePermissionPrompt({
      appId: 'default',
      cancelPermissionApproval,
    } as never);

    try {
      await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        recoveringPermissionRequestId: requestId,
        opsRepository: {
          getJobById: vi.fn(async () => job),
          resumeSetupPausedJob: vi.fn(async () => true),
        } as unknown as RuntimeJobRepository,
        scheduler: { requestSchedulerSync: vi.fn() },
        clock: { now: () => '2026-08-06T00:05:00.000Z' },
      });

      expect(cancelPermissionApproval).not.toHaveBeenCalled();
    } finally {
      configureSetupPausePermissionPrompt(null);
    }
  });

  it('continues post-claim notifications when cross-flow prompt retirement throws', async () => {
    const job = pausedJob(1);
    const sendQueuedReceipt = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const requestSchedulerSync = vi.fn();
    configureSetupPausePermissionPrompt({
      appId: 'default',
      cancelPermissionApproval: vi.fn(async () => {
        throw new Error('prompt store unavailable');
      }),
    } as never);

    try {
      const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        recoveringPermissionRequestId: 'request-access:another-flow',
        opsRepository: {
          getJobById: vi.fn(async () => job),
          resumeSetupPausedJob: vi.fn(async () => true),
        } as unknown as RuntimeJobRepository,
        scheduler: { requestSchedulerSync },
        sendQueuedReceipt,
        publishRuntimeEvent,
        clock: { now: () => '2026-08-06T00:05:00.000Z' },
      });

      expect(result.queued).toHaveLength(1);
      expect(sendQueuedReceipt).toHaveBeenCalledTimes(1);
      expect(publishRuntimeEvent).toHaveBeenCalledTimes(1);
      expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
    } finally {
      configureSetupPausePermissionPrompt(null);
    }
  });

  it('requests scheduler sync when event publication throws after a successful claim', async () => {
    const job = pausedJob(1);
    const requestSchedulerSync = vi.fn();

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        updateJob: vi.fn(),
        resumeSetupPausedJob: vi.fn(async () => true),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      sendQueuedReceipt: vi.fn(async () => undefined),
      publishRuntimeEvent: vi.fn(async () => {
        throw new Error('event exchange unavailable');
      }),
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(result.queued).toHaveLength(1);
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('uses a new persisted transition generation for a later pause with the same capability fingerprint', async () => {
    const job = pausedJob(1);
    const transitions: string[] = [];
    const repository = {
      getJobById: vi.fn(async () => job),
      updateJob: vi.fn(async (_id: string, updates: Partial<Job>) =>
        Object.assign(job, updates),
      ),
      resumeSetupPausedJob: vi.fn(async (input) => {
        if (
          job.status !== 'paused' ||
          job.pause_reason !== input.expectedPauseReason ||
          job.setup_state?.checked_at !== input.expectedSetupCheckedAt
        ) {
          return false;
        }
        Object.assign(job, {
          status: 'active',
          setup_state: input.setupState,
        });
        return true;
      }),
    } as unknown as RuntimeJobRepository;
    const recover = () =>
      recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        opsRepository: repository,
        scheduler: { requestSchedulerSync: vi.fn() },
        sendQueuedReceipt: vi.fn(async (_job, transitionId) => {
          transitions.push(permissionRecoveryNotificationRunId(transitionId));
        }),
        clock: { now: () => '2026-08-06T00:05:00.000Z' },
      });

    await recover();
    Object.assign(job, {
      status: 'paused',
      pause_reason: 'Setup required',
      setup_state: {
        ...job.setup_state!,
        state: 'missing_capability',
        checked_at: '2026-08-06T00:10:00.000Z',
        fingerprint: 'blocked-001',
      },
    });
    await recover();

    expect(transitions).toEqual([
      'permission-recovery:2026-08-06T00:00:00.000Z',
      'permission-recovery:2026-08-06T00:10:00.000Z',
    ]);
  });

  it('dedupes concurrent recovery work for the same persisted transition', async () => {
    const job = pausedJob(1);
    const receipts: string[] = [];
    const resumeSetupPausedJob = vi.fn(async (input) => {
      if (job.status !== 'paused') return false;
      Object.assign(job, { status: 'active', setup_state: input.setupState });
      return true;
    });
    const input = {
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        updateJob: vi.fn(),
        resumeSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      sendQueuedReceipt: vi.fn(async (_job: Job, transitionId: string) => {
        receipts.push(transitionId);
      }),
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    };

    await Promise.all([
      recheckSetupPausedJobsAfterCapabilityUpdate(input),
      recheckSetupPausedJobsAfterCapabilityUpdate(input),
    ]);

    expect(resumeSetupPausedJob).toHaveBeenCalledTimes(2);
    expect(receipts).toEqual(['2026-08-06T00:00:00.000Z']);
  });

  it('re-reads and resumes after losing the ready-job claim once', async () => {
    const job = pausedJob(1);
    const requestSchedulerSync = vi.fn();
    const getJobById = vi.fn(async () => job);
    const resumeSetupPausedJob = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async ({ setupState }) => {
        Object.assign(job, {
          status: 'active',
          pause_reason: null,
          setup_state: setupState,
        });
        return true;
      });

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById,
        resumeSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(getJobById).toHaveBeenCalledTimes(2);
    expect(resumeSetupPausedJob).toHaveBeenCalledTimes(2);
    expect(result.queued).toEqual([
      { jobId: job.id, name: job.name, state: 'queued' },
    ]);
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('syncs a job activated by the concurrent winner of a lost resume claim', async () => {
    const job = pausedJob(1);
    const requestSchedulerSync = vi.fn();
    const resumeSetupPausedJob = vi.fn(async () => {
      Object.assign(job, {
        status: 'active',
        pause_reason: null,
        setup_state: {
          ...job.setup_state!,
          state: 'ready',
        },
      });
      return false;
    });

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        resumeSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(resumeSetupPausedJob).toHaveBeenCalledOnce();
    expect(requestSchedulerSync).toHaveBeenCalledOnce();
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
    expect(result).toEqual({ checked: 0, queued: [], stillBlocked: [] });
  });

  it('re-evaluates a concurrent grant after losing the blocked-state refresh', async () => {
    const job = pausedJob(1);
    job.access_requirements = [
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ];
    let browserGranted = false;
    const requestSchedulerSync = vi.fn();
    const refreshSetupPausedJob = vi.fn(async () => {
      browserGranted = true;
      return false;
    });
    const resumeSetupPausedJob = vi.fn(async ({ setupState }) => {
      Object.assign(job, {
        status: 'active',
        pause_reason: null,
        setup_state: setupState,
      });
      return true;
    });

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        refreshSetupPausedJob,
        resumeSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      toolRepository: {
        listAgentToolBindings: vi.fn(async () =>
          browserGranted ? [{ status: 'active', toolId: 'tool:browser' }] : [],
        ),
        getTool: vi.fn(async () => ({
          appId: 'default',
          id: 'tool:browser',
          name: 'Browser',
          selectable: true,
          status: 'active',
        })),
      } as never,
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(refreshSetupPausedJob).toHaveBeenCalledTimes(1);
    expect(resumeSetupPausedJob).toHaveBeenCalledTimes(1);
    expect(result.queued).toEqual([
      { jobId: job.id, name: job.name, state: 'queued' },
    ]);
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('bounds re-evaluation after repeated lost resume claims', async () => {
    const job = pausedJob(1);
    const getJobById = vi.fn(async () => job);
    const resumeSetupPausedJob = vi.fn(async () => false);
    const requestSchedulerSync = vi.fn();

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById,
        resumeSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(getJobById).toHaveBeenCalledTimes(2);
    expect(resumeSetupPausedJob).toHaveBeenCalledTimes(2);
    expect(requestSchedulerSync).toHaveBeenCalledOnce();
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
    expect(result).toEqual({ checked: 0, queued: [], stillBlocked: [] });
  });

  it('does not resume a job whose pause reason changed before the atomic claim', async () => {
    const job = pausedJob(1);
    const sendQueuedReceipt = vi.fn();
    const requestSchedulerSync = vi.fn();

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        updateJob: vi.fn(),
        resumeSetupPausedJob: vi.fn(async (input) => {
          job.pause_reason = 'Paused by an administrator';
          return (
            job.status === 'paused' &&
            job.pause_reason === input.expectedPauseReason &&
            job.setup_state?.checked_at === input.expectedSetupCheckedAt
          );
        }),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      sendQueuedReceipt,
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(result).toEqual({ checked: 0, queued: [], stillBlocked: [] });
    expect(job.status).toBe('paused');
    expect(job.pause_reason).toBe('Paused by an administrator');
    expect(sendQueuedReceipt).not.toHaveBeenCalled();
    expect(requestSchedulerSync).not.toHaveBeenCalled();
  });

  it('resumes a setup-paused job whose setup state lacks checked_at', async () => {
    const job = pausedJob(1);
    delete (job.setup_state as { checked_at?: string }).checked_at;
    const sendQueuedReceipt = vi.fn();
    const requestSchedulerSync = vi.fn();

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        updateJob: vi.fn(),
        resumeSetupPausedJob: vi.fn(async (input) => {
          if (
            job.status !== 'paused' ||
            job.pause_reason !== input.expectedPauseReason ||
            (job.setup_state?.checked_at ?? job.updated_at) !==
              input.expectedSetupCheckedAt
          ) {
            return false;
          }
          Object.assign(job, {
            status: 'active',
            pause_reason: null,
            setup_state: input.setupState,
          });
          return true;
        }),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync },
      sendQueuedReceipt,
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(result.queued).toEqual([
      { jobId: job.id, name: job.name, state: 'queued' },
    ]);
    expect(sendQueuedReceipt).toHaveBeenCalledWith(
      job,
      '2026-08-06T00:00:00.000Z',
    );
    expect(requestSchedulerSync).toHaveBeenCalledWith(job.id);
  });

  it('visits a paused job whose updated_at advances after the first page', async () => {
    const jobs = Array.from({ length: 101 }, (_, index) => pausedJob(index));
    const visited: string[] = [];
    const listJobs = vi.fn(async (filters?: JobListFilters) => {
      const page = jobs
        .filter((job) => !filters?.pageAfter || job.id < filters.pageAfter.id)
        .sort((left, right) => right.id.localeCompare(left.id))
        .slice(0, filters?.limit);
      if (!filters?.pageAfter) {
        jobs[0]!.updated_at = '2026-08-06T01:00:00.000Z';
      }
      return page;
    });

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      sourceAgentFolder: 'team',
      opsRepository: {
        listJobs,
        getJobById: vi.fn(),
        updateJob: vi.fn(),
        resumeSetupPausedJob: vi.fn(async ({ jobId }) => {
          visited.push(jobId);
          return true;
        }),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(result.queued).toHaveLength(101);
    expect(visited).toContain('job-000');
    expect(listJobs.mock.calls[1]?.[0]?.pageAfter).toEqual({
      createdAt: '2026-08-06T00:00:00.000Z',
      id: 'job-001',
    });
  });

  it('does not overwrite a concurrent resume or re-pause while refreshing a still-blocked job', async () => {
    const job = pausedJob(1);
    job.access_requirements = [
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ];
    const refreshSetupPausedJob = vi.fn(async (input) => {
      job.pause_reason = 'Paused by an administrator';
      return (
        job.status === 'paused' &&
        job.pause_reason === input.expectedPauseReason &&
        (job.setup_state?.checked_at ?? job.updated_at) ===
          input.expectedSetupCheckedAt
      );
    });

    const result = await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: 'default',
      sourceAgentFolder: 'team',
      jobId: job.id,
      opsRepository: {
        getJobById: vi.fn(async () => job),
        updateJob: vi.fn(),
        resumeSetupPausedJob: vi.fn(),
        refreshSetupPausedJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      getBrowserStatus: vi.fn(async () => ({ hasState: false })),
      clock: { now: () => '2026-08-06T00:05:00.000Z' },
    });

    expect(refreshSetupPausedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        expectedPauseReason: 'Setup required',
        expectedSetupCheckedAt: '2026-08-06T00:00:00.000Z',
      }),
    );
    expect(result).toEqual({ checked: 0, queued: [], stillBlocked: [] });
    expect(job.pause_reason).toBe('Paused by an administrator');
  });

  it('routes an already-pending partial-recovery outcome through the normal setup notification fallback', async () => {
    const job = pausedJob(1);
    job.execution_context = {
      ...job.execution_context!,
      conversationJid: 'tg:approver',
      threadId: 'approval-thread',
    };
    job.access_requirements = [
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ];
    configureSetupPausePermissionPrompt({
      appId: 'default',
      getJobById: vi.fn(async () => job),
      cancelPermissionApproval: vi.fn(async () => 'settled' as const),
      runPermissionInteraction: vi.fn(async () => ({
        began: false,
        decision: {
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner-1',
        },
        resolved: false,
      })),
      reviewStoredRequirement: vi.fn(async () => ({
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Browser' }],
          },
        ],
        decisionOptions: ['allow_persistent_rule', 'cancel'],
      })),
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);
    const clearJobSetupNotified = vi.fn(async () => true);

    try {
      await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        opsRepository: {
          getJobById: vi.fn(async () => job),
          refreshSetupPausedJob: vi.fn(async ({ setupState }) => {
            job.setup_state = setupState;
            return true;
          }),
          markJobSetupNotified,
          clearJobSetupNotified,
        } as unknown as RuntimeJobRepository,
        scheduler: { requestSchedulerSync: vi.fn() },
        getBrowserStatus: vi.fn(async () => ({ hasState: false })),
        notifySetupRequired: ({
          job: setupJob,
          setupState,
          previousFingerprint,
        }) =>
          notifyJobSetupRequired({
            currentJob: setupJob,
            deps: {
              sendMessage,
              opsRepository: {
                markJobSetupNotified,
                clearJobSetupNotified,
              },
            } as never,
            runtimeAppId: 'default',
            setupState,
            previousFingerprint,
            source: 'partial_recovery',
            publishRuntimeEvent: async () => undefined,
          }),
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'tg:team-001',
        expect.stringContaining('Setup needed'),
        expect.objectContaining({ threadId: 'thread-001' }),
      );
      expect(sendMessage).toHaveBeenCalledWith(
        'tg:approver',
        expect.stringContaining('Setup needed'),
        expect.objectContaining({ threadId: 'approval-thread' }),
      );
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(markJobSetupNotified).toHaveBeenCalledWith(
        job.id,
        job.setup_state!.fingerprint,
      );
    } finally {
      configureSetupPausePermissionPrompt(null);
    }
  });

  it('routes an instruction-only partial-recovery outcome through the normal setup notification fallback', async () => {
    const job = pausedJob(1);
    job.access_requirements = [
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ];
    configureSetupPausePermissionPrompt({
      appId: 'default',
      getJobById: vi.fn(async () => job),
      cancelPermissionApproval: vi.fn(async () => 'settled' as const),
      runPermissionInteraction: vi.fn(),
      reviewStoredRequirement: vi.fn(async () => null),
    });
    const sendMessage = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);
    const clearJobSetupNotified = vi.fn(async () => true);

    try {
      await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        opsRepository: {
          getJobById: vi.fn(async () => job),
          refreshSetupPausedJob: vi.fn(async ({ setupState }) => {
            job.setup_state = setupState;
            return true;
          }),
          markJobSetupNotified,
          clearJobSetupNotified,
        } as unknown as RuntimeJobRepository,
        scheduler: { requestSchedulerSync: vi.fn() },
        getBrowserStatus: vi.fn(async () => ({ hasState: false })),
        notifySetupRequired: ({
          job: setupJob,
          setupState,
          previousFingerprint,
        }) =>
          notifyJobSetupRequired({
            currentJob: setupJob,
            deps: {
              sendMessage,
              opsRepository: {
                markJobSetupNotified,
                clearJobSetupNotified,
              },
            } as never,
            runtimeAppId: 'default',
            setupState,
            previousFingerprint,
            source: 'partial_recovery',
            publishRuntimeEvent: async () => undefined,
          }),
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'tg:team-001',
        expect.stringContaining('Setup needed'),
        expect.objectContaining({ threadId: 'thread-001' }),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(markJobSetupNotified).toHaveBeenCalledWith(
        job.id,
        job.setup_state!.fingerprint,
      );
    } finally {
      configureSetupPausePermissionPrompt(null);
    }
  });

  it('retries an accurate partial-recovery prompt and does not re-raise after confirmed delivery', async () => {
    const job = pausedJob(1);
    job.access_requirements = [
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ];
    const oldFingerprint = job.setup_state!.fingerprint;
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);
    let promptAttempt = 0;
    const runPermissionInteraction = vi.fn(
      async (_request, delivered: (messageId: string) => void, began) => {
        promptAttempt += 1;
        if (promptAttempt === 1) throw new Error('provider unavailable');
        began();
        delivered('prompt-2');
        return {
          began: true,
          decision: { approved: false, mode: 'cancel', decidedBy: 'owner-1' },
          resolved: true,
        } as const;
      },
    );
    configureSetupPausePermissionPrompt({
      appId: 'default',
      getJobById: vi.fn(async () => job),
      cancelPermissionApproval,
      runPermissionInteraction,
      reviewStoredRequirement: vi.fn(async () => ({
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Browser' }],
          },
        ],
        decisionOptions: ['allow_persistent_rule', 'cancel'],
      })),
    });

    try {
      const markJobSetupNotified = vi.fn(
        async (_jobId: string, expectedFingerprint: string) => {
          job.setup_state!.notified_fingerprint = expectedFingerprint;
          return true;
        },
      );
      const input = {
        appId: 'default',
        sourceAgentFolder: 'team',
        jobId: job.id,
        recoveringPermissionRequestId: setupPausePermissionRequestId(
          job.id,
          oldFingerprint,
        ),
        opsRepository: {
          getJobById: vi.fn(async () => job),
          refreshSetupPausedJob: vi.fn(async ({ setupState }) => {
            job.setup_state = setupState;
            return true;
          }),
          markJobSetupNotified,
        } as unknown as RuntimeJobRepository,
        scheduler: { requestSchedulerSync: vi.fn() },
        getBrowserStatus: vi.fn(async () => ({ hasState: false })),
        clock: { now: () => '2026-08-06T00:05:00.000Z' },
      };

      const first = await recheckSetupPausedJobsAfterCapabilityUpdate(input);

      expect(first.stillBlocked).toHaveLength(1);
      expect(job.setup_state!.fingerprint).not.toBe(oldFingerprint);
      expect(markJobSetupNotified).not.toHaveBeenCalled();
      expect(cancelPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: setupPausePermissionRequestId(job.id, oldFingerprint),
        }),
      );
      expect(runPermissionInteraction).toHaveBeenCalledTimes(1);
      expect(
        runPermissionInteraction.mock.calls[0]?.[0].decisionReason,
      ).toContain('Setup is still incomplete, so this job remains paused.');
      expect(
        runPermissionInteraction.mock.calls[0]?.[0].decisionReason,
      ).toContain('Needed:');
      expect(
        runPermissionInteraction.mock.calls[0]?.[0].decisionReason,
      ).not.toContain('Permission check during the run');
      expect(
        runPermissionInteraction.mock.calls[0]?.[0].decisionReason,
      ).not.toContain('this run stopped before completing');

      await recheckSetupPausedJobsAfterCapabilityUpdate(input);

      const refreshedFingerprint = job.setup_state!.fingerprint;
      expect(runPermissionInteraction).toHaveBeenCalledTimes(2);
      expect(markJobSetupNotified).toHaveBeenCalledWith(
        job.id,
        refreshedFingerprint,
      );

      await recheckSetupPausedJobsAfterCapabilityUpdate(input);

      expect(runPermissionInteraction).toHaveBeenCalledTimes(2);
      expect(markJobSetupNotified).toHaveBeenCalledTimes(1);
    } finally {
      configureSetupPausePermissionPrompt(null);
    }
  });
});
