import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

function contextFor(input: {
  data: Record<string, unknown>;
  renderAgentTodo?: ReturnType<typeof vi.fn>;
}) {
  return {
    data: input.data,
    sourceAgentFolder: 'main_agent',
    deps: {
      ...(input.renderAgentTodo
        ? { renderAgentTodo: input.renderAgentTodo }
        : {}),
    },
    conversationBindings: {},
    sourceAgentFolderJids: ['sl:C123'],
  } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('agent task lifecycle IPC handlers', () => {
  it('renders bounded todo state and returns stable user copy', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
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
        threadId: 'thread-1',
      }),
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
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
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
});
