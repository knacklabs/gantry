import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/jobs/async-mcp-tool-task.js', () => ({
  recoverQueuedAsyncMcpTasks: vi.fn(async () => 1),
}));

import {
  recoverPausedGantryHostedCapabilityJobs,
  recoverStaleAsyncCommandTasks,
  recoverStaleSessionCompactionTasks,
  terminalizeOrphanedGantryHostedCapabilityTasks,
} from '@core/app/bootstrap/runtime-services-async-task-recovery.js';
import { recoverQueuedAsyncMcpTasks } from '@core/jobs/async-mcp-tool-task.js';

describe('recoverStaleAsyncCommandTasks', () => {
  it.each(['submitted', 'acknowledged'])(
    'retains an unsettled %s proof commit for reconciliation',
    async (status) => {
      const task = {
        id: 'task-uncertain',
        appId: 'default',
        kind: 'external_capability',
        status: 'waiting_external',
        parentJobId: 'job-uncertain',
        leaseToken: 'task-lease',
        fencingVersion: 1,
        authoritySnapshotJson: { capabilityId: 'recipe@15' },
        privateCorrelationJson: {
          executionMode: 'gantry_hosted',
          hostedCommit: { status },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const transitionTask = vi.fn(async () => ({
        ...task,
        status: 'timed_out',
      }));
      const count = await terminalizeOrphanedGantryHostedCapabilityTasks(
        'default',
        {
          getAsyncTaskRepository: () =>
            ({ listTasks: async () => [task], transitionTask }) as never,
          opsRepository: {
            getJobById: async () => ({
              id: task.parentJobId,
              status: 'active',
            }),
          } as never,
          logger: { warn: vi.fn() },
        },
      );
      expect(count).toBe(0);
      expect(transitionTask).not.toHaveBeenCalled();
    },
  );

  it.each(['submitted', 'acknowledged'])(
    'requeues a stale paused hosted task with a %s proof for same-task reconciliation',
    async (status) => {
      const task = {
        id: 'task-reconcile',
        appId: 'default',
        kind: 'external_capability',
        status: 'waiting_external',
        parentJobId: 'job-reconcile',
        leaseToken: 'task-lease',
        fencingVersion: 1,
        authoritySnapshotJson: { capabilityId: 'recipe@15' },
        privateCorrelationJson: {
          executionMode: 'gantry_hosted',
          hostedCommit: { status },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const updateJob = vi.fn(async () => undefined);
      const transitionTask = vi.fn();
      const recovered = await recoverPausedGantryHostedCapabilityJobs('default', {
        getAsyncTaskRepository: () =>
          ({ getTask: async () => task, transitionTask }) as never,
        opsRepository: {
          listJobs: async () => [{
            id: task.parentJobId,
            status: 'paused',
            pause_reason: `Waiting for external capability task ${task.id}.`,
          }],
          updateJob,
        } as never,
        logger: { warn: vi.fn() },
      });
      expect(recovered).toBe(1);
      expect(updateJob).toHaveBeenCalledWith(
        task.parentJobId,
        expect.objectContaining({ status: 'active', pause_reason: null }),
      );
      expect(transitionTask).not.toHaveBeenCalled();
    },
  );
  it.each(['active', 'paused'])(
    'does not interrupt a slow hosted validation with a live %s parent lease',
    async (status) => {
      const task = {
        id: 'task-live',
        appId: 'default',
        kind: 'external_capability',
        status: 'waiting_external',
        parentJobId: 'job-live',
        parentJobRunId: 'run-live',
        leaseToken: 'task-lease',
        fencingVersion: 1,
        authoritySnapshotJson: { capabilityId: 'recipe@14' },
        privateCorrelationJson: { executionMode: 'gantry_hosted' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const job = {
        id: 'job-live',
        status,
        lease_run_id: 'run-live',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        pause_reason:
          status === 'paused'
            ? 'Waiting for external capability task task-live.'
            : null,
      };
      const transitionTask = vi.fn(async () => ({
        ...task,
        status: 'timed_out',
      }));
      const getJobRunById = vi.fn(async () => ({
        run_id: 'run-live',
        job_id: 'job-live',
        status: 'running',
        ended_at: null,
        lease_expires_at: job.lease_expires_at,
      }));
      const deps = {
        getAsyncTaskRepository: () =>
          ({
            getTask: vi.fn(async () => task),
            listTasks: vi.fn(async () => [task]),
            transitionTask,
          }) as never,
        opsRepository: {
          getJobById: vi.fn(async () => job),
          listJobs: vi.fn(async () => [job]),
          getJobRunById,
          updateJob: vi.fn(),
        } as never,
        logger: { warn: vi.fn() },
      };
      const count =
        status === 'paused'
          ? await recoverPausedGantryHostedCapabilityJobs('default', deps)
          : await terminalizeOrphanedGantryHostedCapabilityTasks(
              'default',
              deps,
            );
      expect(count).toBe(0);
      expect(transitionTask).not.toHaveBeenCalled();
      expect(getJobRunById).toHaveBeenCalledWith('run-live');
    },
  );

  it('requeues only a job paused on its exact interrupted Gantry-hosted task', async () => {
    const hostedTask = {
      id: 'task-hosted',
      appId: 'default',
      kind: 'external_capability',
      status: 'waiting_external',
      parentJobId: 'job-hosted',
      leaseToken: 'lease-hosted',
      fencingVersion: 1,
      authoritySnapshotJson: { capabilityId: 'recipe@14' },
      privateCorrelationJson: { executionMode: 'gantry_hosted' },
    };
    const externalTask = {
      ...hostedTask,
      id: 'task-external',
      parentJobId: 'job-external',
      privateCorrelationJson: {},
    };
    const getTask = vi.fn(async (id) =>
      id === hostedTask.id ? hostedTask : externalTask,
    );
    const updateJob = vi.fn(async () => undefined);
    const transitionTask = vi.fn(async (input) => ({
      ...hostedTask,
      status: input.status,
      privateCorrelationJson: input.privateCorrelationJson,
    }));
    const onSchedulerChanged = vi.fn();
    const recovered = await recoverPausedGantryHostedCapabilityJobs('default', {
      getAsyncTaskRepository: () => ({ getTask, transitionTask }) as never,
      opsRepository: {
        listJobs: vi.fn(async () => [
          {
            id: 'job-hosted',
            status: 'paused',
            pause_reason: 'Waiting for external capability task task-hosted.',
          },
          {
            id: 'job-external',
            status: 'paused',
            pause_reason: 'Waiting for external capability task task-external.',
          },
        ]),
        updateJob,
      } as never,
      onSchedulerChanged,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(1);
    expect(updateJob).toHaveBeenCalledWith(
      'job-hosted',
      expect.objectContaining({ status: 'active', pause_reason: null }),
    );
    expect(onSchedulerChanged).toHaveBeenCalledWith('job-hosted');
    expect(transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-hosted',
        status: 'timed_out',
      }),
    );
  });

  it('terminalizes only stale orphaned Gantry-hosted tasks', async () => {
    const hostedTask = {
      id: 'task-hosted-orphan',
      appId: 'default',
      kind: 'external_capability',
      status: 'waiting_external',
      parentJobId: 'job-active',
      leaseToken: 'lease-hosted',
      fencingVersion: 1,
      authoritySnapshotJson: { capabilityId: 'recipe@14' },
      privateCorrelationJson: { executionMode: 'gantry_hosted' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const externalTask = {
      ...hostedTask,
      id: 'task-external',
      privateCorrelationJson: {},
    };
    const transitionTask = vi.fn(async (input) => ({
      ...hostedTask,
      status: input.status,
    }));

    const recovered = await terminalizeOrphanedGantryHostedCapabilityTasks(
      'default',
      {
        getAsyncTaskRepository: () =>
          ({
            listTasks: vi.fn(async () => [hostedTask, externalTask]),
            transitionTask,
          }) as never,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            id: 'job-active',
            status: 'active',
            pause_reason: null,
          })),
        } as never,
        logger: { warn: vi.fn() },
      },
    );

    expect(recovered).toBe(1);
    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-hosted-orphan',
        status: 'timed_out',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  });

  it('does not requeue a hosted task unless the parent is paused on that exact task', async () => {
    const updateJob = vi.fn(async () => undefined);
    const recovered = await recoverPausedGantryHostedCapabilityJobs('default', {
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async () => ({
            id: 'task-hosted',
            parentJobId: 'job-other',
            kind: 'external_capability',
            status: 'waiting_external',
            privateCorrelationJson: {
              hostedValidation: { completedCases: {} },
            },
          })),
        }) as never,
      opsRepository: {
        listJobs: vi.fn(async () => [
          {
            id: 'job-hosted',
            status: 'paused',
            pause_reason: 'Waiting for external capability task task-hosted.',
          },
        ]),
        updateJob,
      } as never,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(0);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('does not requeue a hosted task owned by another app', async () => {
    const updateJob = vi.fn(async () => undefined);
    const recovered = await recoverPausedGantryHostedCapabilityJobs('default', {
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async () => ({
            id: 'task-other-app',
            appId: 'app:other',
            parentJobId: 'job-other-app',
            kind: 'external_capability',
            status: 'waiting_external',
            privateCorrelationJson: { executionMode: 'gantry_hosted' },
          })),
        }) as never,
      opsRepository: {
        listJobs: vi.fn(async () => [
          {
            id: 'job-other-app',
            status: 'paused',
            pause_reason:
              'Waiting for external capability task task-other-app.',
          },
        ]),
        updateJob,
      } as never,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(0);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('does not requeue a paused hosted job while its task is still reporting progress', async () => {
    const updateJob = vi.fn(async () => undefined);
    const recovered = await recoverPausedGantryHostedCapabilityJobs('default', {
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async () => ({
            id: 'task-hosted-active',
            parentJobId: 'job-hosted-active',
            kind: 'external_capability',
            status: 'waiting_external',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            privateCorrelationJson: { executionMode: 'gantry_hosted' },
          })),
        }) as never,
      opsRepository: {
        listJobs: vi.fn(async () => [
          {
            id: 'job-hosted-active',
            status: 'paused',
            pause_reason:
              'Waiting for external capability task task-hosted-active.',
          },
        ]),
        updateJob,
      } as never,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(0);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('recovers queued command and MCP tasks without an enforcing sandbox', async () => {
    const listCalls: unknown[] = [];
    const repository = {
      listTasks: vi.fn(async (input) => {
        listCalls.push(input);
        return [];
      }),
    };
    const warn = vi.fn();

    await recoverStaleAsyncCommandTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      runnerSandboxProvider: { enforcing: false } as never,
      logger: { warn },
    });

    expect(recoverQueuedAsyncMcpTasks).toHaveBeenCalledWith({
      repository,
      appId: 'default',
      createProxy: expect.any(Function),
    });
    expect(listCalls).toContainEqual(
      expect.objectContaining({
        kind: 'async_command',
        statuses: ['queued'],
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      { queuedMcp: 1 },
      'Recovered queued async MCP tasks',
    );
  });

  it('runs session compaction recovery before generic stale task recovery', async () => {
    const listCalls: unknown[] = [];
    const repository = {
      listTasks: vi.fn(async (input) => {
        listCalls.push(input);
        return [];
      }),
    };

    await recoverStaleAsyncCommandTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      runnerSandboxProvider: { enforcing: false } as never,
      logger: { warn: vi.fn() },
    });

    expect(listCalls[0]).toMatchObject({
      kind: 'session_compaction',
      statuses: ['queued', 'running'],
    });
  });

  it('terminalizes stale session compaction tasks and releases maintenance locks', async () => {
    const staleTask = {
      id: 'task-compact-stale',
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'chat-1',
      threadId: null,
      kind: 'session_compaction',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        agentSessionId: 'agent-session-1',
        provider: 'deepagents:langchain',
        providerSessionId: 'provider-session-1',
        externalSessionId: 'provider-session-1',
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
      heartbeatAt: '2026-04-27T00:00:00.000Z',
    };
    const terminalTask = {
      ...staleTask,
      status: 'timed_out',
      terminalAt: '2026-04-27T00:11:00.000Z',
    };
    const repository = {
      listTasks: vi.fn(async () => [staleTask]),
      transitionTask: vi.fn(async () => terminalTask),
    };
    const finishProviderSessionMaintenance = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    const recovered = await recoverStaleSessionCompactionTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      opsRepository: { finishProviderSessionMaintenance } as never,
      publishRuntimeEvent,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(1);
    expect(repository.transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-compact-stale',
        status: 'timed_out',
        errorSummary: 'Session compaction exceeded the 10 minute timeout.',
        expectedUpdatedAt: '2026-04-27T00:00:00.000Z',
      }),
    );
    expect(finishProviderSessionMaintenance).toHaveBeenCalledWith({
      providerSessionId: 'provider-session-1',
      agentSessionId: 'agent-session-1',
      provider: 'deepagents:langchain',
      externalSessionId: 'provider-session-1',
      status: 'expired',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'session.compaction.timeout',
        payload: expect.objectContaining({
          state: 'timeout',
          taskId: 'task-compact-stale',
        }),
      }),
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls[0])).not.toContain(
      'provider-session-1',
    );
  });

  it('leaves maintenance locks alone when a stale compaction heartbeat wins the race', async () => {
    const staleTask = {
      id: 'task-compact-heartbeated',
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'chat-1',
      threadId: null,
      kind: 'session_compaction',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        agentSessionId: 'agent-session-1',
        provider: 'deepagents:langchain',
        providerSessionId: 'provider-session-1',
        externalSessionId: 'provider-session-1',
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
      heartbeatAt: '2026-04-27T00:00:00.000Z',
    };
    const repository = {
      listTasks: vi.fn(async () => [staleTask]),
      transitionTask: vi.fn(async () => null),
    };
    const finishProviderSessionMaintenance = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    const recovered = await recoverStaleSessionCompactionTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      opsRepository: { finishProviderSessionMaintenance } as never,
      publishRuntimeEvent,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(0);
    expect(repository.transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-compact-heartbeated',
        expectedUpdatedAt: '2026-04-27T00:00:00.000Z',
      }),
    );
    expect(finishProviderSessionMaintenance).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
  });
});
