import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DelegatedTask } from '@core/domain/ports/task-lifecycle.js';
import { appendLiveToolRules } from '@core/shared/live-tool-rules.js';

const runtimeHomes: string[] = [];

async function loadTaskLifecycleHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers =
    await import('@core/jobs/ipc-agent-task-lifecycle-handlers.js');
  return {
    ...handlers,
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
        agentId: 'agent:main',
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

function task(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: 'task-1',
    appId: 'app:test',
    agentId: 'agent:main',
    principalId: 'sl:C123',
    conversationId: 'sl:C123',
    threadId: 'thread-1',
    parentRunId: 'run-id-1',
    runHandle: 'run-1',
    idempotencyKey: 'delegate:key',
    capabilityScope: 'AgentDelegation',
    ownerWorkerId: 'main_agent',
    leaseToken: 'lease-1',
    fencingVersion: 7,
    status: 'running',
    providerCorrelation: {},
    progressCursor: null,
    title: 'Research options',
    task: 'Compare options',
    expectedOutput: 'Decision notes',
    context: null,
    resultSummary: null,
    errorSummary: null,
    terminalReceipt: null,
    cancelReason: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    startedAt: '2026-06-17T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

function contextFor(input: {
  data: Record<string, unknown>;
  ipcBaseDir?: string;
  taskLifecycleRepository: Record<string, ReturnType<typeof vi.fn>>;
}) {
  return {
    data: input.data,
    sourceAgentFolder: 'main_agent',
    ipcBaseDir: input.ipcBaseDir,
    deps: {
      getTaskLifecycleRepository: () => input.taskLifecycleRepository,
    },
    conversationBindings: {},
    sourceAgentFolderJids: ['sl:C123'],
  } as never;
}

function addLiveDelegationRule(ipcBaseDir: string) {
  appendLiveToolRules({
    ipcDir: path.join(ipcBaseDir, 'main_agent'),
    runHandle: 'run-1',
    rules: ['AgentDelegation'],
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('agent task lifecycle IPC handlers', () => {
  it('persists bounded todo state and returns stable user copy', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const recordTodoUpdate = vi.fn(async (input) => ({
      outcome: 'created',
      update: {
        id: 'todo-1',
        appId: input.scope.appId,
        agentId: input.scope.agentId,
        principalId: input.scope.principalId,
        conversationId: input.scope.conversationId,
        threadId: input.scope.threadId,
        parentRunId: input.scope.parentRunId,
        runHandle: input.scope.runHandle,
        seq: 1,
        summary: input.summary,
        items: input.items,
        createdAt: '2026-06-17T00:00:00.000Z',
      },
    }));

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
        taskLifecycleRepository: { recordTodoUpdate },
      }),
    );

    expect(recordTodoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          appId: 'app:test',
          agentId: 'agent:main',
          principalId: 'sl:C123',
          conversationId: 'sl:C123',
          threadId: 'thread-1',
          parentRunId: 'run-id-1',
          runHandle: 'run-1',
        },
        summary: 'Current plan',
        items: [
          {
            id: 'step-1',
            title: 'Validate contract',
            status: 'inProgress',
            note: 'Checking surface',
          },
        ],
        fence: { leaseToken: 'lease-1', fencingVersion: 7 },
        fencingVersion: 7,
      }),
    );
    expect(readResponse(runtimeHome, 'todo-ok')).toMatchObject({
      ok: true,
      message: 'Plan updated.',
      data: { outcome: 'created', todoUpdateId: 'todo-1' },
    });
  });

  it('rejects stale-fenced todo_update before channel render', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const recordTodoUpdate = vi.fn(async () => ({
      outcome: 'stale_fence',
    }));
    const renderAgentTodo = vi.fn();

    await agentTaskLifecycleHandlers.todo_update({
      ...contextFor({
        data: taskData('todo-stale', 'todo_update', {
          items: [{ id: 'step-1', title: 'Validate', status: 'pending' }],
        }),
        taskLifecycleRepository: { recordTodoUpdate },
      }),
      deps: {
        getTaskLifecycleRepository: () => ({ recordTodoUpdate }),
        renderAgentTodo,
      },
    } as never);

    expect(recordTodoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        fence: { leaseToken: 'lease-1', fencingVersion: 7 },
      }),
    );
    expect(renderAgentTodo).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'todo-stale')).toMatchObject({
      ok: false,
      code: 'stale_fence',
      error: 'Plan update rejected because the run lease is no longer active.',
    });
  });

  it('denies delegate_task before repository launch when AgentDelegation is absent', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const launchDelegatedTask = vi.fn();

    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: taskData('delegate-denied', 'delegate_task', {
          title: 'Research options',
          task: 'Compare options',
          expectedOutput: 'Decision notes',
        }),
        taskLifecycleRepository: { launchDelegatedTask },
      }),
    );

    expect(launchDelegatedTask).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'delegate-denied')).toMatchObject({
      ok: false,
      code: 'missing_capability',
      error: 'Agent delegation is not approved for this agent.',
    });
  });

  it('denies delegate_task before repository launch when no Gantry executor is configured', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'ipc');
    addLiveDelegationRule(ipcBaseDir);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const launchDelegatedTask = vi.fn();

    await agentTaskLifecycleHandlers.delegate_task(
      contextFor({
        data: taskData('delegate-unavailable', 'delegate_task', {
          title: 'Research options',
          task: 'Compare options',
          expectedOutput: 'Decision notes',
          context: 'Keep it short',
        }),
        ipcBaseDir,
        taskLifecycleRepository: { launchDelegatedTask },
      }),
    );

    expect(launchDelegatedTask).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'delegate-unavailable')).toMatchObject({
      ok: false,
      code: 'unavailable_in_mode',
      error:
        'Agent delegation is unavailable in this mode because no Gantry delegation executor is configured.',
    });
  });

  it('returns terminal receipt lines from task_get', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'ipc');
    addLiveDelegationRule(ipcBaseDir);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const getDelegatedTask = vi.fn(async () => ({
      outcome: 'found',
      task: task({
        status: 'completed',
        resultSummary: 'Picked option A',
        terminalReceipt: {
          completed: 'Picked option A',
          used: 'FileRead, WebRead',
          changed: 'none',
          delegated: 'yes',
          needsAttention: 'none',
        },
      }),
    }));

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: taskData('task-get', 'task_get', { taskId: 'task-1' }),
        ipcBaseDir,
        taskLifecycleRepository: { getDelegatedTask },
      }),
    );

    expect(getDelegatedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        fence: { leaseToken: 'lease-1', fencingVersion: 7 },
      }),
    );
    expect(readResponse(runtimeHome, 'task-get')).toMatchObject({
      ok: true,
      message:
        'Completed: Picked option A\nUsed: FileRead, WebRead\nChanged: none\nDelegated: yes\nNeeds attention: none',
      data: {
        receipt: {
          Completed: 'Picked option A',
          Used: 'FileRead, WebRead',
          Changed: 'none',
          Delegated: 'yes',
          'Needs attention': 'none',
        },
      },
    });
  });

  it('writes cancellation through Gantry lifecycle before reporting success', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'ipc');
    addLiveDelegationRule(ipcBaseDir);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const cancelDelegatedTask = vi.fn(async () => ({
      outcome: 'cancelled',
      task: task({
        status: 'cancelled',
        cancelReason: 'No longer needed',
        terminalReceipt: {
          completed: 'Cancelled before provider output.',
          used: 'AgentDelegation',
          changed: 'none',
          delegated: 'yes',
          needsAttention: 'none',
        },
      }),
    }));

    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: taskData('task-cancel', 'task_cancel', {
          taskId: 'task-1',
          reason: 'No longer needed',
        }),
        ipcBaseDir,
        taskLifecycleRepository: { cancelDelegatedTask },
      }),
    );

    expect(cancelDelegatedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        fence: { leaseToken: 'lease-1', fencingVersion: 7 },
        reason: 'No longer needed',
      }),
    );
    expect(readResponse(runtimeHome, 'task-cancel')).toMatchObject({
      ok: true,
      message: 'Delegated work was cancelled. Nothing else changed.',
      data: { status: 'cancelled' },
    });
  });

  it('rejects task_cancel when the delegated task is already terminal', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'ipc');
    addLiveDelegationRule(ipcBaseDir);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const cancelDelegatedTask = vi.fn(async () => ({
      outcome: 'already_terminal',
      task: task({
        status: 'completed',
        terminalReceipt: {
          completed: 'Already done.',
          used: 'AgentDelegation',
          changed: 'none',
          delegated: 'yes',
          needsAttention: 'none',
        },
      }),
    }));

    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: taskData('task-cancel-terminal', 'task_cancel', {
          taskId: 'task-1',
        }),
        ipcBaseDir,
        taskLifecycleRepository: { cancelDelegatedTask },
      }),
    );

    expect(readResponse(runtimeHome, 'task-cancel-terminal')).toMatchObject({
      ok: false,
      code: 'already_terminal',
      error: 'Delegated task is already finished and cannot be cancelled.',
    });
  });
});
