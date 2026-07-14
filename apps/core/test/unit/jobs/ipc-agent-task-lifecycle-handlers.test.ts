import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskStatusCount,
  AsyncTaskTransitionInput,
} from '@core/domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '@core/domain/ports/async-tasks.js';
import { readEncryptedAsyncTaskPayload } from '@core/jobs/async-task-execution-payload.js';
import type { RunnerSandboxProvider } from '@core/shared/runner-sandbox-provider.js';

const runtimeHomes: string[] = [];

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
          (filter.conversationId === undefined ||
            task.conversationId === filter.conversationId) &&
          (filter.providerAccountId === undefined ||
            (task.privateCorrelationJson.providerAccountId ?? null) ===
              filter.providerAccountId) &&
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

function fakeEnforcingSandboxProvider(input?: {
  onKill?: () => void;
  onStart?: (options: unknown) => void;
}): RunnerSandboxProvider {
  return {
    id: 'sandbox_runtime',
    enforcing: true,
    start: vi.fn((options) => {
      input?.onStart?.(options);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        input?.onKill?.();
        setImmediate(() => {
          child.emit('exit', null, 'SIGTERM');
          child.emit('close', null, 'SIGTERM');
        });
        return true;
      });
      return child as never;
    }),
  };
}

async function loadTaskLifecycleHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const asyncPolicy =
    await import('@core/runtime/async-command-sandbox-policy.js');
  const handlers =
    await import('@core/jobs/ipc-agent-task-lifecycle-handlers.js');
  return {
    ...handlers,
    ...asyncPolicy,
    taskData: (
      taskId: string,
      type: string,
      payload: Record<string, unknown> = {},
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('main_agent', 'thread-1');
      return {
        type,
        taskId,
        appId: 'app:test',
        agentId: 'agent:main_agent',
        chatJid: 'sl:C123',
        jid: 'sl:C123',
        authThreadId: 'thread-1',
        responseKeyId: envelope.responseKeyId,
        runHandle: 'run-1',
        runId: 'run-id-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 7,
        payload,
      };
    },
  };
}

function readResponse(runtimeHome: string, taskId: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'data',
        'ipc',
        'main_agent',
        'task-responses',
        `task-${taskId}.json`,
      ),
      'utf-8',
    ),
  );
}

function contextFor(input: {
  data: Record<string, unknown>;
  renderAgentTodo?: ReturnType<typeof vi.fn>;
  liveStopActionToken?: string;
  deps?: Record<string, unknown>;
  conversationBindings?: Record<string, unknown>;
}) {
  return {
    data: {
      ...input.data,
      ...(input.liveStopActionToken
        ? { liveStopActionToken: input.liveStopActionToken }
        : {}),
    },
    sourceAgentFolder: 'main_agent',
    deps: {
      ...(input.renderAgentTodo
        ? { renderAgentTodo: input.renderAgentTodo }
        : {}),
      ...(input.deps ?? {}),
    },
    conversationBindings: input.conversationBindings ?? {},
    sourceAgentFolderJids: ['sl:C123'],
  } as never;
}

async function waitForStatus(
  repository: MemoryAsyncTaskRepository,
  status: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.status === status,
    );
    if (task) return task.id;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Task did not reach ${status}.`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('agent task lifecycle IPC handlers', () => {
  beforeEach(() => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });

  it('renders bounded todo state and returns stable user copy', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const renderAgentTodo = vi.fn(async () => undefined);

    await agentTaskLifecycleHandlers.todo_update(
      contextFor({
        data: taskData('todo-ok', 'todo_update', {
          summary: 'Current plan',
          items: [
            {
              id: 'step-1',
              title: 'Validate contract',
              status: 'inProgress',
              note: 'Checking surface',
            },
          ],
        }),
        renderAgentTodo,
        liveStopActionToken: 'stop-token-1',
      }),
    );

    expect(renderAgentTodo).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        summary: 'Current plan',
        items: [
          {
            id: 'step-1',
            title: 'Validate contract',
            status: 'inProgress',
            note: 'Checking surface',
          },
        ],
        stop: { label: 'Stop', actionToken: 'stop-token-1' },
        threadId: 'thread-1',
        updatedAt: expect.any(String),
      }),
      undefined,
    );
    expect(readResponse(runtimeHome, 'todo-ok')).toMatchObject({
      ok: true,
      message: 'Plan updated.',
    });
  });

  it('rejects invalid todo_update before channel render', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const renderAgentTodo = vi.fn();

    await agentTaskLifecycleHandlers.todo_update(
      contextFor({
        data: taskData('todo-stale', 'todo_update', {
          items: [{ id: 'step-1', title: 'Validate', status: 'invalid' }],
        }),
        renderAgentTodo,
      }),
    );

    expect(renderAgentTodo).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'todo-stale')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'todo_update requires 1-50 unique items with id, title, and status.',
    });
  });

  it('starts, reads, lists, and cancels scoped async command tasks', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:permission-rule:test' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'RunCommand(echo *)',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider({
        onStart: (options) => {
          expect(options).toMatchObject({
            cwd: path.join(runtimeHome, 'agents', 'main_agent'),
            workspaceRoot: path.join(runtimeHome, 'agents', 'main_agent'),
            protectedReadPaths: ['/protected/read'],
            protectedWritePaths: ['/protected/write'],
            allowedNetworkHosts: ['127.0.0.1:1234'],
            egressProxyUrl: 'http://127.0.0.1:1234',
            resourceLimits: {
              cpuSeconds: 10,
              memoryMb: 128,
              maxProcesses: 8,
            },
            sandboxProfile: {
              network: 'required',
            },
          });
        },
      }),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: ['/protected/read'],
        protectedWritePaths: ['/protected/write'],
        allowedNetworkHosts: ['127.0.0.1:1234'],
        resourceLimits: {
          cpuSeconds: 10,
          memoryMb: 128,
          maxProcesses: 8,
        },
      },
    });

    await agentTaskLifecycleHandlers.async_run_command(
      contextFor({
        data: taskData('async-start', 'async_run_command', {
          command: 'echo ok',
        }),
        deps,
      }),
    );

    const taskId = await waitForStatus(repository, 'running');
    const runningTask = repository.tasks.get(taskId);
    expect(runningTask).toBeTruthy();
    if (!runningTask) return;
    repository.tasks.set(taskId, {
      ...runningTask,
      heartbeatAt: '2026-06-22T00:00:05.000Z',
      startedAt: '2026-06-22T00:00:00.000Z',
      privateCorrelationJson: {
        ...runningTask.privateCorrelationJson,
        progress: {
          phase: 'running',
          elapsedMs: 5_000,
          stdoutTail: 'ipc stdout tail',
          stderrTail: 'ipc stderr tail',
          stdout: 'ipc private full stdout',
          stderr: 'ipc private full stderr',
          privateCorrelationJson: { nested: true },
          leaseToken: 'nested-lease',
          fencingVersion: 3,
        },
      },
    });
    expect(readResponse(runtimeHome, 'async-start')).toMatchObject({
      ok: true,
      message: 'Queued: echo ok',
      data: { id: taskId, status: 'queued', kind: 'async_command' },
    });

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: {
          ...taskData('async-cross-app-get', 'task_get', { taskId }),
          appId: 'app:other',
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'async-cross-app-get')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: taskData('async-get', 'task_get', { taskId }),
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'async-get')).toMatchObject({
      ok: true,
      data: {
        id: taskId,
        status: 'running',
        kind: 'async_command',
        currentPhase: 'running',
        heartbeatAt: '2026-06-22T00:00:05.000Z',
        elapsedMs: expect.any(Number),
        stdoutTail: 'ipc stdout tail',
        stderrTail: 'ipc stderr tail',
        allowedActions: ['get', 'list', 'cancel'],
      },
    });
    expect(
      readResponse(runtimeHome, 'async-get').data.elapsedMs,
    ).toBeGreaterThanOrEqual(0);
    const getJson = JSON.stringify(readResponse(runtimeHome, 'async-get'));
    expect(getJson).not.toContain('privateCorrelationJson');
    expect(getJson).not.toContain('process');
    expect(getJson).not.toContain('leaseToken');
    expect(getJson).not.toContain('fencingVersion');
    expect(getJson).not.toContain('ipc private full stdout');
    expect(getJson).not.toContain('ipc private full stderr');

    await agentTaskLifecycleHandlers.task_list(
      contextFor({
        data: taskData('async-list', 'task_list', {}),
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'async-list')).toMatchObject({
      ok: true,
      data: { tasks: [expect.objectContaining({ id: taskId })] },
    });

    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: taskData('async-cancel', 'task_cancel', { taskId }),
        deps,
      }),
    );
    expect(repository.tasks.get(taskId)?.status).toBe('cancelled');
    expect(readResponse(runtimeHome, 'async-cancel')).toMatchObject({
      ok: true,
      message: 'Task was cancelled. Nothing else changed.',
      data: { taskId },
    });
  });

  it('scopes a targeted delegate to child-created async tasks', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    const parent = await repository.createTask({
      id: 'task_parent',
      appId: 'app:test',
      agentId: 'agent:caller',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
      parentRunId: 'run-id-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { toolName: 'delegate_task' },
      privateCorrelationJson: { targetAgentId: 'agent:main_agent' },
      leaseToken: 'parent-lease',
      fencingVersion: 1,
      now,
    });
    const child = await repository.createTask({
      id: 'task_child',
      appId: 'app:test',
      agentId: 'agent:main_agent',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
      parentRunId: 'run-id-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { command: 'echo child' },
      privateCorrelationJson: {
        parentTaskId: parent.id,
        process: {
          pid: 9999991,
          processGroupId: null,
          detached: false,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'child-lease',
      fencingVersion: 1,
      now,
    });
    const sibling = await repository.createTask({
      id: 'task_sibling',
      appId: 'app:test',
      agentId: 'agent:main_agent',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
      parentRunId: 'run-id-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { command: 'echo sibling' },
      privateCorrelationJson: {},
      leaseToken: 'sibling-lease',
      fencingVersion: 1,
      now,
    });
    await repository.createTask({
      id: 'task_delegated_sibling',
      appId: 'app:test',
      agentId: 'agent:main_agent',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
      parentRunId: 'run-id-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { toolName: 'delegate_task' },
      privateCorrelationJson: { workspaceFolder: 'main_agent' },
      leaseToken: 'delegated-sibling-lease',
      fencingVersion: 1,
      now,
    });
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:delegation' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'AgentDelegation',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 10,
          memoryMb: 128,
          maxProcesses: 8,
        },
      },
    });

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: {
          ...taskData('child-get-own', 'task_get', { taskId: child.id }),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'child-get-own')).toMatchObject({
      ok: true,
      data: { id: child.id },
    });

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: {
          ...taskData('child-get-sibling', 'task_get', { taskId: sibling.id }),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'child-get-sibling')).toMatchObject({
      ok: false,
      code: 'not_found',
    });

    await agentTaskLifecycleHandlers.task_list(
      contextFor({
        data: {
          ...taskData('child-list', 'task_list', {}),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'child-list')).toMatchObject({
      ok: true,
      data: { tasks: [expect.objectContaining({ id: child.id })] },
    });

    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: {
          ...taskData('child-cancel-parent', 'task_cancel', {
            taskId: parent.id,
          }),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'child-cancel-parent')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(repository.tasks.get(parent.id)?.status).toBe('running');

    await agentTaskLifecycleHandlers.task_message(
      contextFor({
        data: {
          ...taskData('child-steer-sibling', 'task_message', {
            taskId: 'task_delegated_sibling',
            message: 'Change direction.',
          }),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'child-steer-sibling')).toMatchObject({
      ok: false,
      error: 'Task not found.',
    });

    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: {
          ...taskData('child-cancel-own', 'task_cancel', { taskId: child.id }),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'child-cancel-own')).toMatchObject({
      ok: true,
    });
    expect(repository.tasks.get(child.id)?.status).toBe('cancelled');
  });

  it('stores scheduled job run ids in the job-run parent column', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:permission-rule:test' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'RunCommand(echo *)',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'job-run-1',
        jobId: 'job-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 300,
          memoryMb: 1024,
          maxProcesses: 64,
        },
      },
    });

    await agentTaskLifecycleHandlers.async_run_command(
      contextFor({
        data: {
          ...taskData('async-job-start', 'async_run_command', {
            command: 'echo ok',
          }),
          jobId: 'job-1',
          runId: 'job-run-1',
        },
        deps,
      }),
    );

    const taskId = await waitForStatus(repository, 'running');
    expect(repository.tasks.get(taskId)).toMatchObject({
      parentRunId: null,
      parentJobId: 'job-1',
      parentJobRunId: 'job-run-1',
    });
    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: {
          ...taskData('async-job-cancel', 'task_cancel', { taskId }),
          jobId: 'job-1',
          runId: 'job-run-1',
        },
        deps,
      }),
    );
  });

  it('delegates an async child run to a bound target agent', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const runAgent = vi.fn(
      async (group, input, onProcess, onOutput, options) => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          killed: boolean;
          kill: ReturnType<typeof vi.fn>;
        };
        child.pid = 34567;
        child.killed = false;
        child.kill = vi.fn(() => {
          child.killed = true;
          return true;
        });
        onProcess(child as never, 'child-run-1');
        await onOutput?.({
          status: 'success',
          result: 'halfway',
        });
        expect(input.prompt).toContain('Objective: Research lead sources');
        expect(group.folder).toBe('reviewer');
        expect(input.agentId).toBe('agent:reviewer');
        expect(input.workspaceFolder).toBe('reviewer');
        expect(options?.asyncTaskRepositoryAvailable).toBe(true);
        return { status: 'success', result: 'delegated done' };
      },
    );
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listTools: async () => [],
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:delegation' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'AgentDelegation',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
      runAgent,
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        providerAccountId: 'slack-one',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 300,
          memoryMb: 1024,
          maxProcesses: 64,
        },
      },
    });

    const conversationBindings = {
      'sl:C123': {
        jid: 'sl:C123',
        name: 'Lead gen',
        folder: 'main_agent',
        providerAccountId: 'slack-one',
        isRegistered: true,
      },
      'sl:C123::thread:thread-1::agent:agent%3Areviewer': {
        jid: 'sl:C123',
        name: 'Reviewer',
        folder: 'reviewer',
        agentId: 'agent:reviewer',
        providerAccountId: 'slack-one',
        isRegistered: true,
      },
    };

    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: {
          ...taskData('delegate-wrong-account', 'delegate_task', {
            objective: 'Research lead sources',
            targetAgentId: 'agent:reviewer',
          }),
          providerAccountId: 'slack-two',
        },
        deps,
        conversationBindings,
      }),
    );
    expect(readResponse(runtimeHome, 'delegate-wrong-account')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(repository.tasks.size).toBe(0);

    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: {
          ...taskData('delegate-start', 'delegate_task', {
            objective: 'Research lead sources',
            targetAgentId: 'agent:reviewer',
          }),
          providerAccountId: 'slack-one',
        },
        deps,
        conversationBindings,
      }),
    );

    const taskId = [...repository.tasks.values()][0]?.id;
    expect(taskId).toBeTruthy();
    expect(readResponse(runtimeHome, 'delegate-start')).toMatchObject({
      ok: true,
      data: { id: taskId, kind: 'delegated_agent' },
    });
    expect(repository.tasks.get(taskId!)?.privateCorrelationJson).toMatchObject(
      { targetAgentId: 'agent:reviewer', workspaceFolder: 'reviewer' },
    );
    expect(
      readEncryptedAsyncTaskPayload<{ providerAccountId?: string }>(
        repository.tasks.get(taskId!)!,
      ),
    ).toMatchObject({ providerAccountId: 'slack-one' });
    await waitForStatus(repository, 'completed');

    runAgent.mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'Reviewed three sources.',
        });
        return {
          status: 'error',
          result: null,
          error: 'Lead source review failed.',
        };
      },
    );
    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: {
          ...taskData('delegate-failure', 'delegate_task', {
            objective: 'Review lead sources',
            targetAgentId: 'agent:reviewer',
          }),
          providerAccountId: 'slack-one',
        },
        deps,
        conversationBindings,
      }),
    );
    const failedTaskId = await waitForStatus(repository, 'failed');
    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: {
          ...taskData('delegate-failure-get', 'task_get', {
            taskId: failedTaskId,
          }),
          providerAccountId: 'slack-one',
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'delegate-failure-get')).toMatchObject({
      ok: true,
      data: {
        status: 'failed',
        failure: {
          type: 'execution',
          attemptedAction: 'Review lead sources',
          partialResult: 'Reviewed three sources.',
        },
      },
    });

    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-other-account',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        providerAccountId: 'slack-two',
        threadId: 'thread-1',
        runId: 'run-id-2',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: { cpuSeconds: 300, memoryMb: 1024, maxProcesses: 64 },
      },
    });
    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: {
          ...taskData('delegate-cross-account-get', 'task_get', { taskId }),
          providerAccountId: 'slack-two',
          runHandle: 'run-other-account',
          runId: 'run-id-2',
        },
        deps,
      }),
    );
    expect(
      readResponse(runtimeHome, 'delegate-cross-account-get'),
    ).toMatchObject({ ok: false, code: 'not_found' });

    await agentTaskLifecycleHandlers.task_message(
      contextFor({
        data: {
          ...taskData('delegate-message', 'task_message', {
            taskId,
            message: 'Narrow the scope.',
          }),
          providerAccountId: 'slack-one',
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'delegate-message')).toMatchObject({
      ok: false,
      error: 'Task is already finished and cannot receive messages.',
    });
  });

  it('fails delegated runs when child process handle persistence fails', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const originalTransition = repository.transitionTask.bind(repository);
    repository.transitionTask = async (input) => {
      if (input.privateCorrelationJson?.process) return null;
      return originalTransition(input);
    };
    const kill = vi.fn(() => true);
    const runAgent = vi.fn(async (_group, _input, onProcess) => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 45678;
      child.kill = kill;
      onProcess(child as never, 'child-run-1');
      return { status: 'success', result: 'delegated done' };
    });
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listTools: async () => [],
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:delegation' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'AgentDelegation',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
      runAgent,
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 300,
          memoryMb: 1024,
          maxProcesses: 64,
        },
      },
    });

    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: taskData('delegate-persist-fails', 'delegate_task', {
          objective: 'Research lead sources',
        }),
        deps,
        conversationBindings: {
          'sl:C123': {
            jid: 'sl:C123',
            name: 'Lead gen',
            folder: 'main_agent',
            isRegistered: true,
          },
        },
      }),
    );

    const taskId = [...repository.tasks.values()][0]?.id;
    expect(taskId).toBeTruthy();
    if (!taskId) return;
    await waitForStatus(repository, 'failed');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(repository.tasks.get(taskId)?.errorSummary).toContain(
      'Could not persist delegated task progress.',
    );
  });

  it('rejects child async commands when the delegated parent is terminal', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const parent = await repository.createTask({
      id: 'task_parent',
      appId: 'app:test',
      agentId: 'agent:main_agent',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
      parentRunId: 'run-id-1',
      kind: 'delegated_agent',
      status: 'cancelled',
      admissionClass: 'task',
      authoritySnapshotJson: { toolName: 'delegate_task' },
      privateCorrelationJson: {},
      leaseToken: 'parent-lease',
      fencingVersion: 1,
      now: new Date().toISOString(),
    });
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:permission-rule:test' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'RunCommand(echo *)',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 10,
          memoryMb: 128,
          maxProcesses: 8,
        },
      },
    });

    await agentTaskLifecycleHandlers.async_run_command(
      contextFor({
        data: {
          ...taskData('child-after-cancel', 'async_run_command', {
            command: 'echo late',
          }),
          parentTaskId: parent.id,
        },
        deps,
      }),
    );

    expect(readResponse(runtimeHome, 'child-after-cancel')).toMatchObject({
      ok: false,
      code: 'forbidden',
      error: 'Parent delegated task is not active in this scope.',
    });
    expect(repository.tasks.size).toBe(1);
  });

  it('rejects steering without AgentDelegation access', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    await repository.createTask({
      id: 'task_delegate',
      appId: 'app:test',
      agentId: 'agent:main_agent',
      conversationId: 'sl:C123',
      threadId: 'thread-1',
      parentRunId: 'run-id-1',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { toolName: 'delegate_task' },
      privateCorrelationJson: { workspaceFolder: 'main_agent' },
      leaseToken: 'delegate-lease',
      fencingVersion: 1,
      now: new Date().toISOString(),
    });
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listTools: async () => [],
          listAgentToolBindings: async () => [],
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 10,
          memoryMb: 128,
          maxProcesses: 8,
        },
      },
    });

    await agentTaskLifecycleHandlers.task_message(
      contextFor({
        data: taskData('steer-no-access', 'task_message', {
          taskId: 'task_delegate',
          message: 'Change direction',
        }),
        deps,
      }),
    );

    expect(readResponse(runtimeHome, 'steer-no-access')).toMatchObject({
      ok: false,
      code: 'forbidden',
      error: 'task_message requires AgentDelegation access.',
    });
    expect(
      repository.tasks.get('task_delegate')?.privateCorrelationJson,
    ).toEqual({ workspaceFolder: 'main_agent' });
  });

  it('rejects recursive delegated tasks from a child task', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const deps = {
      getAsyncTaskRepository: () => repository,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 300,
          memoryMb: 1024,
          maxProcesses: 64,
        },
      },
    });

    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: {
          ...taskData('delegate-nested', 'delegate_task', {
            objective: 'Nested work',
          }),
          parentTaskId: 'task_parent',
        },
        deps,
        conversationBindings: {
          'sl:C123': {
            jid: 'sl:C123',
            name: 'Lead gen',
            folder: 'main_agent',
            isRegistered: true,
          },
        },
      }),
    );

    expect(readResponse(runtimeHome, 'delegate-nested')).toMatchObject({
      ok: false,
      error: 'delegate_task cannot be called from a delegated task.',
    });
    expect(repository.tasks.size).toBe(0);
  });
});
