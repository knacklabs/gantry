import { describe, expect, it, vi } from 'vitest';

import {
  AsyncCommandTaskService,
  type AsyncCommandRunner,
} from '@core/jobs/async-command-task-service.js';
import { persistInspectionSnapshot } from '@core/jobs/async-command-task-helpers.js';
import type {
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskStatusCount,
  AsyncTaskTransitionInput,
} from '@core/domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '@core/domain/ports/async-tasks.js';

class MemoryAsyncTaskRepository implements AsyncTaskRepository {
  readonly tasks = new Map<string, AsyncTaskRecord>();

  async createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord> {
    const task: AsyncTaskRecord = {
      id: input.id,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      threadId: input.threadId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentJobId: input.parentJobId ?? null,
      parentJobRunId: input.parentJobRunId ?? null,
      kind: input.kind,
      status: input.status,
      admissionClass: input.admissionClass,
      authoritySnapshotJson: input.authoritySnapshotJson,
      privateCorrelationJson: input.privateCorrelationJson ?? {},
      leaseToken: input.leaseToken,
      fencingVersion: input.fencingVersion,
      createdAt: input.now,
      updatedAt: input.now,
      summary: input.summary ?? null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async getTask(taskId: string): Promise<AsyncTaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.appId === filter.appId &&
          (!filter.agentId || task.agentId === filter.agentId) &&
          (!filter.kind || task.kind === filter.kind) &&
          (filter.parentTaskId === undefined ||
            task.privateCorrelationJson.parentTaskId === filter.parentTaskId) &&
          (!filter.statuses || filter.statuses.includes(task.status)),
      )
      .slice(0, filter.limit ?? 50);
  }

  async countTasksByStatus(
    filter: Omit<AsyncTaskListFilter, 'limit'>,
  ): Promise<AsyncTaskStatusCount[]> {
    const counts = new Map<AsyncTaskRecord['status'], number>();
    const tasks = await this.listTasks({
      ...filter,
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const task of tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    return [...counts.entries()].map(([status, count]) => ({ status, count }));
  }

  async updateTaskReceipt(
    taskId: string,
    receiptJson: AsyncTaskRecord['receiptJson'],
    now: string,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const next = { ...current, receiptJson, updatedAt: now };
    this.tasks.set(taskId, next);
    return next;
  }

  async transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(input.taskId);
    if (
      !current ||
      current.leaseToken !== input.leaseToken ||
      current.fencingVersion !== input.fencingVersion ||
      (input.expectedUpdatedAt &&
        current.updatedAt !== input.expectedUpdatedAt) ||
      (input.expectedPrivateCorrelationJson &&
        JSON.stringify(current.privateCorrelationJson) !==
          JSON.stringify(input.expectedPrivateCorrelationJson)) ||
      isAsyncTaskTerminal(current.status)
    ) {
      return null;
    }
    const next: AsyncTaskRecord = {
      ...current,
      status: input.status,
      updatedAt: input.now,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      startedAt: input.startedAt ?? current.startedAt,
      terminalAt: input.terminalAt ?? current.terminalAt,
      privateCorrelationJson:
        input.privateCorrelationJson ?? current.privateCorrelationJson,
      outputSummary: input.outputSummary ?? current.outputSummary,
      errorSummary: input.errorSummary ?? current.errorSummary,
      receiptJson: input.receiptJson ?? current.receiptJson,
    };
    this.tasks.set(next.id, next);
    return next;
  }
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    command: 'npm test',
    allowedToolRules: ['RunCommand(npm test)'],
    ...overrides,
  };
}

describe('AsyncCommandTaskService', () => {
  it('denies unapproved commands before creating a task or calling the runner', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let calls = 0;
    const runner: AsyncCommandRunner = {
      run: async () => {
        calls += 1;
        return {};
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);

    const result = await service.start(
      baseInput({ allowedToolRules: ['RunCommand(git status)'] }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        'This command is not approved for this agent. Request access or choose an approved capability.',
    });
    expect(calls).toBe(0);
    expect(repository.tasks.size).toBe(0);
  });

  it('redacts command text before persisting durable task metadata', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const runner: AsyncCommandRunner = {
      run: async () => ({ outputSummary: 'done' }),
    };
    const service = new AsyncCommandTaskService(repository, runner);
    const secret = 'bearer abcdefghijklmnopqrstuvwxyz123456';

    const result = await service.start(
      baseInput({
        command: `curl -H "Authorization: ${secret}" https://example.com`,
        allowedToolRules: ['RunCommand(curl *)'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = repository.tasks.get(result.task.id);
    const persisted = JSON.stringify(task);
    expect(task?.summary).toContain('bearer [REDACTED_SECRET]');
    expect(persisted).not.toContain(secret);
  });

  it('creates a durable row before running and keeps cancellation terminal', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runner: AsyncCommandRunner = {
      run: async ({ signal, onProcessStarted }) => {
        onProcessStarted?.({
          pid: 12345,
          processGroupId: 12345,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: new Date().toISOString(),
        });
        await runnerStarted;
        if (signal.aborted) throw new Error('aborted');
        return { outputSummary: 'done' };
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);

    const started = await service.start(baseInput());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(repository.tasks.has(started.task.id)).toBe(true);

    await waitForStatus(repository, started.task.id, 'running');
    await expect(service.cancel(started.task.id)).resolves.toEqual({
      ok: true,
      message: 'Task was cancelled. Nothing else changed.',
    });
    releaseRunner();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.tasks.get(started.task.id);
    expect(task?.status).toBe('cancelled');
    expect(task?.privateCorrelationJson).toMatchObject({
      cwd: null,
      process: {
        pid: 12345,
        processGroupId: 12345,
        detached: true,
        platform: process.platform,
        ownerPid: process.pid,
      },
    });
    expect(JSON.stringify(task?.privateCorrelationJson)).not.toContain(
      'npm test',
    );
    expect(task?.receiptJson).toEqual({
      completed: 'cancelled',
      used: 'RunCommand',
      changed: 'none',
      delegated: 'no',
      needsAttention: 'none',
    });
    const dto = await service.get(started.task.id);
    expect(dto).toMatchObject({
      id: started.task.id,
      status: 'cancelled',
      allowedActions: ['get', 'list'],
      receiptLines: [
        'Completed: cancelled',
        'Used: RunCommand',
        'Changed: none',
        'Delegated: no',
        'Needs attention: none',
      ],
    });
    expect(JSON.stringify(dto)).not.toContain('leaseToken');
    expect(JSON.stringify(dto)).not.toContain('privateCorrelationJson');
    expect(JSON.stringify(dto)).not.toContain('fencingVersion');
  });

  it('denies new launches when the agent async command budget is full', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const runner: AsyncCommandRunner = {
      run: async () => new Promise(() => undefined),
    };
    const service = new AsyncCommandTaskService(repository, runner);

    await expect(service.start(baseInput())).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.start(baseInput())).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.start(baseInput())).resolves.toEqual({
      ok: false,
      message:
        'Async command capacity is full for this agent. Wait for an existing task to finish or cancel one.',
    });
  });

  it('does not count non-command tasks against async command admission capacity', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-mcp',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'mcp_tool_call',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-mcp',
      fencingVersion: 1,
      now,
    });
    await repository.createTask({
      id: 'task-delegated',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-delegated',
      fencingVersion: 1,
      now,
    });
    const runner: AsyncCommandRunner = {
      run: async () => new Promise(() => undefined),
    };
    const service = new AsyncCommandTaskService(repository, runner);

    await expect(service.start(baseInput())).resolves.toMatchObject({
      ok: true,
    });

    expect(
      [...repository.tasks.values()].filter(
        (task) => task.kind === 'async_command',
      ),
    ).toHaveLength(1);
  });

  it('applies active task backpressure to delegated agents before child spawn', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });
    const activeChildSpawn = vi.fn(
      async () => new Promise<never>(() => undefined),
    );

    await expect(
      service.startDelegatedAgent({
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        objective: 'Research accounts',
        workspaceFolder: 'main_agent',
        run: activeChildSpawn,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.startDelegatedAgent({
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        objective: 'Draft accounts',
        workspaceFolder: 'main_agent',
        run: activeChildSpawn,
      }),
    ).resolves.toMatchObject({ ok: true });
    const childSpawn = vi.fn(async () => ({ outputSummary: 'done' }));

    await expect(
      service.startDelegatedAgent({
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        objective: 'Research accounts',
        workspaceFolder: 'main_agent',
        run: childSpawn,
      }),
    ).resolves.toEqual({
      ok: false,
      message:
        'Async command capacity is full for this agent. Wait for an existing task to finish or cancel one.',
    });

    expect(childSpawn).not.toHaveBeenCalled();
    expect([...repository.tasks.values()].map((task) => task.kind)).toEqual([
      'delegated_agent',
      'delegated_agent',
    ]);
  });

  it('does not claim cancellation when this process has no active handle', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-detached',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now,
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel('task-detached')).resolves.toEqual({
      ok: false,
      message:
        'Task has no recoverable process handle. Wait for stale-task recovery before starting or cancelling it again.',
    });
    expect(repository.tasks.get('task-detached')?.status).toBe('running');
  });

  it('cancels a detached task with its persisted process handle after restart', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-detached',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 45678,
          processGroupId: 45678,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now,
    });
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      {
        run: async () => ({}),
      },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );

    await expect(service.cancel('task-detached')).resolves.toEqual({
      ok: true,
      message: 'Task was cancelled. Nothing else changed.',
    });
    expect(killed).toEqual([45678]);
    expect(repository.tasks.get('task-detached')?.status).toBe('cancelled');
  });

  it('records delegated receipts when cancelling delegated tasks', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-delegated',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 45679,
          processGroupId: 45679,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now,
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel('task-delegated')).resolves.toMatchObject({
      ok: true,
    });
    expect(repository.tasks.get('task-delegated')?.receiptJson).toMatchObject({
      used: 'Gantry agent run',
      delegated: 'yes',
      subtasks: '0 completed, 0 failed, 1 cancelled',
    });
  });

  it('cancels async command children when cancelling delegated tasks', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-parent',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 45681,
          processGroupId: 45681,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-parent',
      fencingVersion: 1,
      now,
    });
    await repository.createTask({
      id: 'task-child',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        parentTaskId: 'task-parent',
        process: {
          pid: 45680,
          processGroupId: 45680,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-child',
      fencingVersion: 1,
      now,
    });
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      { run: async () => ({}) },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );

    await expect(service.cancel('task-parent')).resolves.toMatchObject({
      ok: true,
    });
    expect(repository.tasks.get('task-child')?.status).toBe('cancelled');
    expect(repository.tasks.get('task-parent')?.receiptJson).toMatchObject({
      subtasks: '0 completed, 0 failed, 1 cancelled',
    });
    expect(killed).toEqual([45681, 45680]);
  });

  it('cancels all async command children beyond the first list page', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-parent',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 44_999,
          processGroupId: 44_999,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-parent',
      fencingVersion: 1,
      now,
    });
    for (let index = 0; index < 101; index += 1) {
      await repository.createTask({
        id: `task-child-${index}`,
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        kind: 'async_command',
        status: 'running',
        admissionClass: 'task',
        authoritySnapshotJson: {},
        privateCorrelationJson: {
          parentTaskId: 'task-parent',
          process: {
            pid: 45_000 + index,
            processGroupId: 45_000 + index,
            detached: true,
            platform: process.platform,
            ownerPid: process.pid,
            startedAt: now,
          },
        },
        leaseToken: `lease-child-${index}`,
        fencingVersion: 1,
        now,
      });
    }
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel('task-parent')).resolves.toMatchObject({
      ok: true,
    });
    const activeChildren = [...repository.tasks.values()].filter(
      (task) =>
        task.privateCorrelationJson.parentTaskId === 'task-parent' &&
        !isAsyncTaskTerminal(task.status),
    );
    expect(activeChildren).toEqual([]);
    expect(repository.tasks.get('task-parent')?.receiptJson).toMatchObject({
      subtasks: '0 completed, 0 failed, 101 cancelled',
    });
  });

  it('cancels child tasks created during delegated parent cancellation', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-parent',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 44_998,
          processGroupId: 44_998,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-parent',
      fencingVersion: 1,
      now,
    });
    await repository.createTask({
      id: 'task-child-existing',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        parentTaskId: 'task-parent',
        process: {
          pid: 45_998,
          processGroupId: 45_998,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-child-existing',
      fencingVersion: 1,
      now,
    });
    const originalTransition = repository.transitionTask.bind(repository);
    let lateChildCreated = false;
    repository.transitionTask = async (input) => {
      const result = await originalTransition(input);
      if (
        result?.id === 'task-parent' &&
        input.status === 'cancelled' &&
        !lateChildCreated
      ) {
        lateChildCreated = true;
        await repository.createTask({
          id: 'task-child-late',
          appId: 'app-1',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          kind: 'async_command',
          status: 'running',
          admissionClass: 'task',
          authoritySnapshotJson: {},
          privateCorrelationJson: {
            parentTaskId: 'task-parent',
            process: {
              pid: 45_999,
              processGroupId: 45_999,
              detached: true,
              platform: process.platform,
              ownerPid: process.pid,
              startedAt: now,
            },
          },
          leaseToken: 'lease-child-late',
          fencingVersion: 1,
          now,
        });
      }
      return result;
    };
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel('task-parent')).resolves.toMatchObject({
      ok: true,
    });
    expect(repository.tasks.get('task-child-existing')?.status).toBe(
      'cancelled',
    );
    expect(repository.tasks.get('task-child-late')?.status).toBe('cancelled');
    expect(repository.tasks.get('task-parent')?.receiptJson).toMatchObject({
      subtasks: '0 completed, 0 failed, 2 cancelled',
    });
  });

  it('waits for active child tasks beyond the terminal child page before completing delegated tasks', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });
    let activeChild: AsyncTaskRecord | null = null;
    const started = await service.startDelegatedAgent({
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      objective: 'Research many leads',
      workspaceFolder: 'main_agent',
      run: async ({ task }) => {
        const now = new Date().toISOString();
        for (let index = 0; index < 100; index += 1) {
          await repository.createTask({
            id: `task-terminal-${index}`,
            appId: task.appId,
            agentId: task.agentId,
            conversationId: task.conversationId,
            kind: 'async_command',
            status: 'completed',
            admissionClass: 'task',
            authoritySnapshotJson: {},
            privateCorrelationJson: { parentTaskId: task.id },
            leaseToken: `terminal-lease-${index}`,
            fencingVersion: 1,
            now,
          });
        }
        activeChild = await repository.createTask({
          id: 'task-active-hidden',
          appId: task.appId,
          agentId: task.agentId,
          conversationId: task.conversationId,
          kind: 'async_command',
          status: 'running',
          admissionClass: 'task',
          authoritySnapshotJson: {},
          privateCorrelationJson: { parentTaskId: task.id },
          leaseToken: 'active-lease',
          fencingVersion: 1,
          now,
        });
        return { outputSummary: 'delegated done' };
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repository.tasks.get(started.task.id)?.status).toBe('running');
    expect(activeChild).toBeTruthy();
    if (!activeChild) return;
    const now = new Date().toISOString();
    await repository.transitionTask({
      taskId: activeChild.id,
      leaseToken: activeChild.leaseToken,
      fencingVersion: activeChild.fencingVersion,
      status: 'completed',
      now,
      terminalAt: now,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    await waitForStatus(repository, started.task.id, 'completed');
  });

  it('fails delegated tasks when a failed child is beyond the terminal child page', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });
    const started = await service.startDelegatedAgent({
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      objective: 'Research many leads',
      workspaceFolder: 'main_agent',
      run: async ({ task }) => {
        const now = new Date().toISOString();
        for (let index = 0; index < 100; index += 1) {
          await repository.createTask({
            id: `task-terminal-success-${index}`,
            appId: task.appId,
            agentId: task.agentId,
            conversationId: task.conversationId,
            kind: 'async_command',
            status: 'completed',
            admissionClass: 'task',
            authoritySnapshotJson: {},
            privateCorrelationJson: { parentTaskId: task.id },
            leaseToken: `terminal-success-lease-${index}`,
            fencingVersion: 1,
            now,
          });
        }
        await repository.createTask({
          id: 'task-failed-hidden',
          appId: task.appId,
          agentId: task.agentId,
          conversationId: task.conversationId,
          kind: 'async_command',
          status: 'failed',
          admissionClass: 'task',
          authoritySnapshotJson: {},
          privateCorrelationJson: { parentTaskId: task.id },
          leaseToken: 'failed-lease',
          fencingVersion: 1,
          now,
        });
        return { outputSummary: 'delegated done' };
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForStatus(repository, started.task.id, 'failed');
    expect(repository.tasks.get(started.task.id)?.receiptJson).toMatchObject({
      subtasks: '101 completed, 1 failed, 0 cancelled',
    });
  });

  it('keeps concurrent steering messages in durable state', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });
    const started = await service.startDelegatedAgent({
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      objective: 'Research the docs',
      workspaceFolder: 'main_agent',
      run: async () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ outputSummary: 'done' }), 20),
        ),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForStatus(repository, started.task.id, 'running');

    await Promise.all([
      service.message({
        taskId: started.task.id,
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        message: 'first',
        deliver: () => undefined,
      }),
      service.message({
        taskId: started.task.id,
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        message: 'second',
        deliver: () => undefined,
      }),
    ]);

    const task = repository.tasks.get(started.task.id);
    expect(task?.privateCorrelationJson.steering).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'first', status: 'consumed' }),
        expect.objectContaining({ message: 'second', status: 'consumed' }),
      ]),
    );
  });

  it('does not deliver steering after a concurrent terminal transition', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-delegated',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: { workspaceFolder: 'main_agent' },
      leaseToken: 'lease-delegated',
      fencingVersion: 1,
      now,
    });
    const originalTransition = repository.transitionTask.bind(repository);
    let cancelledAfterAppend = false;
    repository.transitionTask = async (input) => {
      const result = await originalTransition(input);
      const steering = result?.privateCorrelationJson.steering;
      if (
        result?.id === 'task-delegated' &&
        Array.isArray(steering) &&
        steering.some((entry) => entry?.status === 'pending') &&
        !cancelledAfterAppend
      ) {
        cancelledAfterAppend = true;
        await originalTransition({
          taskId: result.id,
          leaseToken: result.leaseToken,
          fencingVersion: result.fencingVersion,
          status: 'cancelled',
          now: new Date().toISOString(),
          terminalAt: new Date().toISOString(),
        });
      }
      return result;
    };
    const deliver = vi.fn();
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(
      service.message({
        taskId: 'task-delegated',
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        message: 'late steer',
        deliver,
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Task is already finished and cannot receive messages.',
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(repository.tasks.get('task-delegated')?.status).toBe('cancelled');
  });

  it('terminates tracked stale task processes during recovery', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const stale = new Date(Date.now() - 120_000).toISOString();
    await repository.createTask({
      id: 'task-stale',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 56789,
          processGroupId: 56789,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: stale,
        },
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now: stale,
    });
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      {
        run: async () => ({}),
      },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );

    await expect(
      service.recoverStaleTasks({ appId: 'app-1', staleAfterMs: 1 }),
    ).resolves.toBe(1);
    expect(killed).toEqual([56789]);
    expect(repository.tasks.get('task-stale')?.status).toBe('failed');
  });

  it('cancels delegated child tasks during stale parent recovery', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const stale = new Date(Date.now() - 120_000).toISOString();
    const processHandle = (pid: number) => ({
      pid,
      processGroupId: pid,
      detached: true,
      platform: process.platform,
      ownerPid: process.pid,
      startedAt: stale,
    });
    await repository.createTask({
      id: 'task-parent',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: { process: processHandle(56789) },
      leaseToken: 'lease-parent',
      fencingVersion: 1,
      now: stale,
    });
    await repository.createTask({
      id: 'task-child',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        parentTaskId: 'task-parent',
        process: processHandle(56790),
      },
      leaseToken: 'lease-child',
      fencingVersion: 1,
      now: stale,
    });
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      { run: async () => ({}) },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );

    await expect(
      service.recoverStaleTasks({ appId: 'app-1', staleAfterMs: 1 }),
    ).resolves.toBe(1);
    expect(repository.tasks.get('task-parent')?.status).toBe('failed');
    expect(repository.tasks.get('task-child')?.status).toBe('cancelled');
    expect(killed.sort()).toEqual([56789, 56790]);
  });

  it('keeps stale MCP recovery retry guidance side-effect safe', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const stale = new Date(Date.now() - 120_000).toISOString();
    await repository.createTask({
      id: 'task-mcp',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'mcp_tool_call',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { mcpToolRule: 'mcp__crm__create_deal' },
      privateCorrelationJson: {},
      leaseToken: 'lease-mcp',
      fencingVersion: 1,
      now: stale,
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(
      service.recoverStaleTasks({ appId: 'app-1', staleAfterMs: 1 }),
    ).resolves.toBe(1);
    expect(repository.tasks.get('task-mcp')?.receiptJson).toMatchObject({
      used: 'mcp__crm__create_deal',
      needsAttention:
        'check the remote MCP system before retrying; work may have already run',
    });
  });

  it('cancels recovered running MCP tasks with a fenced terminal state', async () => {
    const repository = new MemoryAsyncTaskRepository();
    await repository.createTask({
      id: 'task-mcp',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'mcp_tool_call',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { mcpToolRule: 'mcp__crm__create_deal' },
      privateCorrelationJson: {},
      leaseToken: 'lease-mcp',
      fencingVersion: 1,
      now: new Date().toISOString(),
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel('task-mcp')).resolves.toEqual({
      ok: true,
      message:
        'Task was cancelled in Gantry. Remote MCP work may have already run; late results will be ignored.',
    });
    expect(repository.tasks.get('task-mcp')?.status).toBe('cancelled');
    expect(
      repository.tasks.get('task-mcp')?.privateCorrelationJson,
    ).toMatchObject({
      progress: {
        phase: 'cancelled',
        lastProgress: 'MCP tool cancelled.',
      },
    });
  });

  it('starts delegated agent tasks and records steering messages', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    const started = await service.startDelegatedAgent({
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentRunId: 'run-1',
      objective: 'Research the docs',
      workspaceFolder: 'main_agent',
      run: async ({ prompt, signal, onProcessStarted, onProgress }) => {
        expect(prompt).toContain('Objective: Research the docs');
        await onProcessStarted?.({
          pid: 24680,
          processGroupId: null,
          detached: false,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: new Date().toISOString(),
        });
        await onProgress?.('Reading docs');
        await running;
        if (signal.aborted) throw new Error('aborted');
        return { outputSummary: 'docs reviewed' };
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForStatus(repository, started.task.id, 'running');
    const sent: string[] = [];
    await expect(
      service.message({
        taskId: started.task.id,
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        message: 'Focus on steering.',
        deliver: (_task, message) => {
          sent.push(message);
        },
      }),
    ).resolves.toEqual({
      ok: true,
      message: 'Message sent to delegated task.',
    });
    expect(sent).toEqual(['Focus on steering.']);
    const dto = await service.get(started.task.id);
    expect(dto).toMatchObject({
      kind: 'delegated_agent',
      status: 'running',
      currentPhase: 'running',
      lastProgress: 'Reading docs',
      consumedSteeringCount: 1,
    });

    release();
    await waitForStatus(repository, started.task.id, 'completed');
    expect((await service.get(started.task.id))?.receiptLines).toEqual([
      'Completed: docs reviewed',
      'Used: Gantry agent run',
      'Changed: none',
      'Delegated: yes',
      'Subtasks: 1 completed, 0 failed, 0 cancelled',
      'Needs attention: none',
    ]);
  });

  it('cancels child async commands when delegated agent run fails', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      { run: async () => ({}) },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );
    const started = await service.startDelegatedAgent({
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentRunId: 'run-1',
      objective: 'Run failing child work',
      workspaceFolder: 'main_agent',
      run: async ({ task }) => {
        await repository.createTask({
          id: 'task-child-failed-parent',
          appId: task.appId,
          agentId: task.agentId,
          conversationId: task.conversationId,
          kind: 'async_command',
          status: 'running',
          admissionClass: 'task',
          authoritySnapshotJson: {},
          privateCorrelationJson: {
            parentTaskId: task.id,
            process: {
              pid: 45691,
              processGroupId: 45691,
              detached: true,
              platform: process.platform,
              ownerPid: process.pid,
              startedAt: now,
            },
          },
          leaseToken: 'lease-child-failed-parent',
          fencingVersion: 1,
          now,
        });
        throw new Error('delegated runner failed');
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForStatus(repository, started.task.id, 'failed');
    expect(repository.tasks.get('task-child-failed-parent')?.status).toBe(
      'cancelled',
    );
    expect(killed).toEqual([45691]);
  });

  it('persists redacted bounded output snapshots while command is running', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let releaseRunner!: () => void;
    let snapshotPersisted!: () => void;
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const snapshotWritten = new Promise<void>((resolve) => {
      snapshotPersisted = resolve;
    });
    const secret = `sk-ant-${'a'.repeat(24)}`;
    const runner: AsyncCommandRunner = {
      run: async ({ onProcessStarted, onOutputSnapshot }) => {
        await onProcessStarted?.({
          pid: 45693,
          processGroupId: 45693,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: new Date().toISOString(),
        });
        await Promise.resolve(
          onOutputSnapshot?.({
            stdoutTail: `${'x'.repeat(1_200)} ${secret}`,
            stderrTail: `failed with ${secret}`,
          }),
        );
        snapshotPersisted();
        await runnerReleased;
        return { outputSummary: 'done' };
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);

    const started = await service.start(baseInput());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForStatus(repository, started.task.id, 'running');
    await snapshotWritten;

    const dto = await service.get(started.task.id);

    expect(dto).toMatchObject({
      status: 'running',
      stdoutTail: expect.stringContaining('[REDACTED_SECRET]'),
      stderrTail: expect.stringContaining('[REDACTED_SECRET]'),
    });
    expect(dto?.stdoutTail?.length).toBeLessThanOrEqual(1_003);
    expect(JSON.stringify(dto)).not.toContain(secret);
    releaseRunner();
    await waitForStatus(repository, started.task.id, 'completed');
  });

  it('preserves early output snapshot when process handle is persisted later', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let allowProcessStart!: () => void;
    const processStartAllowed = new Promise<void>((resolve) => {
      allowProcessStart = resolve;
    });
    const runner: AsyncCommandRunner = {
      run: async ({ onProcessStarted, onOutputSnapshot }) => {
        const processStarted = Promise.resolve(
          onProcessStarted?.({
            pid: 45694,
            processGroupId: 45694,
            detached: true,
            platform: process.platform,
            ownerPid: process.pid,
            startedAt: new Date().toISOString(),
          }),
        );
        await Promise.resolve(
          onOutputSnapshot?.({
            stdoutTail: 'early stdout',
            stderrTail: 'early stderr',
          }),
        );
        allowProcessStart();
        await processStarted;
        return { outputSummary: 'done' };
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);
    const originalGetTask = repository.getTask.bind(repository);
    let delayProcessMerge = true;
    repository.getTask = async (taskId) => {
      if (delayProcessMerge) {
        delayProcessMerge = false;
        await processStartAllowed;
      }
      return originalGetTask(taskId);
    };

    const started = await service.start(baseInput());
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForStatus(repository, started.task.id, 'completed');
    const correlation =
      repository.tasks.get(started.task.id)?.privateCorrelationJson ?? {};
    expect(correlation.progress).toMatchObject({
      stdoutTail: 'early stdout',
      stderrTail: 'early stderr',
    });
    expect(correlation.process).toMatchObject({ pid: 45694 });
  });

  it('drops inspection snapshots from stale task owners', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const task = await repository.createTask({
      id: 'task-stale-snapshot',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'agent',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'old-token',
      fencingVersion: 1,
      now: new Date().toISOString(),
    });
    repository.tasks.set(task.id, {
      ...task,
      leaseToken: 'new-token',
      fencingVersion: 2,
    });

    await persistInspectionSnapshot({
      repository,
      task,
      snapshot: { stdoutTail: 'stale output' },
    });

    expect(
      repository.tasks.get(task.id)?.privateCorrelationJson.progress,
    ).toBeUndefined();
  });

  it('retries inspection snapshot writes that race process handle persistence', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const task = await repository.createTask({
      id: 'task-snapshot-process-race',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'agent',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'token',
      fencingVersion: 1,
      now: new Date().toISOString(),
    });
    const originalTransition = repository.transitionTask.bind(repository);
    let raced = false;
    repository.transitionTask = async (input) => {
      if (!raced && input.privateCorrelationJson?.progress) {
        raced = true;
        const current = repository.tasks.get(task.id);
        if (current) {
          repository.tasks.set(task.id, {
            ...current,
            privateCorrelationJson: {
              ...current.privateCorrelationJson,
              process: { pid: 45696 },
            },
          });
        }
      }
      return originalTransition(input);
    };

    await persistInspectionSnapshot({
      repository,
      task,
      snapshot: { stdoutTail: 'latest output' },
    });

    expect(repository.tasks.get(task.id)?.privateCorrelationJson).toMatchObject(
      {
        process: { pid: 45696 },
        progress: { stdoutTail: 'latest output' },
      },
    );
  });

  it('drops process handles from stale task owners', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const runner: AsyncCommandRunner = {
      run: async ({ onProcessStarted }) => {
        await onProcessStarted?.({
          pid: 45695,
          processGroupId: 45695,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: new Date().toISOString(),
        });
        return { outputSummary: 'done' };
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);
    const originalGetTask = repository.getTask.bind(repository);
    repository.getTask = async (taskId) => {
      const latest = await originalGetTask(taskId);
      return latest
        ? { ...latest, leaseToken: 'new-token', fencingVersion: 2 }
        : latest;
    };

    const started = await service.start(baseInput());
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForStatus(repository, started.task.id, 'failed');
    expect(
      repository.tasks.get(started.task.id)?.privateCorrelationJson.process,
    ).toBeUndefined();
  });

  it('rejects steering for async command and terminal tasks', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-command',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now,
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(
      service.message({
        taskId: 'task-command',
        appId: 'app-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        message: 'hello',
        deliver: () => undefined,
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'task_message is only available for delegated agent tasks.',
    });
  });
});

async function waitForStatus(
  repository: MemoryAsyncTaskRepository,
  taskId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (repository.tasks.get(taskId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Task did not reach ${status}.`);
}
