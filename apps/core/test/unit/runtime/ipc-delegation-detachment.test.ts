import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  dataDir: `/tmp/gantry-ipc-delegation-detachment-${process.pid}`,
  processTaskIpc: async (_args: unknown[]): Promise<void> => undefined,
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: testState.dataDir,
  IPC_POLL_INTERVAL: 5,
}));

vi.mock('@core/jobs/ipc-handler.js', () => ({
  processTaskIpc: (...args: unknown[]) => testState.processTaskIpc(args),
}));

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import { startIpcWatcher, stopIpcWatcher } from '@core/runtime/ipc.js';
import { isLongRunningTask } from '@core/runtime/ipc-long-running-task.js';
import {
  taskIpcResponsePath,
  writeTaskIpcResponse,
} from '@core/jobs/ipc-shared.js';

describe('delegation IPC detachment', () => {
  const sourceAgentFolder = 'orchestrator_agent';
  const appId = 'app:test';
  const agentId = 'agent:orchestrator';
  const conversationId = 'conversation:test';

  beforeEach(() => {
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
    testState.processTaskIpc = async () => undefined;
  });

  afterEach(() => {
    stopIpcWatcher();
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
  });

  it('processes a response-requiring callee task while the parent delegation is waiting', async () => {
    expect(isLongRunningTask('delegate_task')).toBe(true);
    expect(isLongRunningTask('task_get')).toBe(false);

    const controlPort = new FilesystemRunnerControlPort(
      path.join(testState.dataDir, 'ipc'),
    );
    controlPort.ensureRoot();
    controlPort.ensureWorkspaceLayout(sourceAgentFolder);
    const auth = createIpcAuthEnvelope(sourceAgentFolder, null, {
      appId,
      agentId,
    });
    let markDelegationStarted!: () => void;
    const delegationStarted = new Promise<void>((resolve) => {
      markDelegationStarted = resolve;
    });
    let releaseDelegation!: () => void;
    const delegationWait = new Promise<void>((resolve) => {
      releaseDelegation = resolve;
    });

    testState.processTaskIpc = async ([rawData, rawSourceAgentFolder]) => {
      const data = rawData as {
        type: string;
        taskId: string;
        authThreadId?: string;
        responseKeyId?: string;
      };
      const folder = String(rawSourceAgentFolder);
      if (data.type === 'delegate_task') {
        markDelegationStarted();
        await delegationWait;
        writeTaskIpcResponse(
          folder,
          data.taskId,
          { ok: true, message: 'delegation complete' },
          data.authThreadId,
          data.responseKeyId,
        );
        return;
      }
      if (data.type === 'task_get') {
        writeTaskIpcResponse(
          folder,
          data.taskId,
          { ok: true, message: 'callee response' },
          data.authThreadId,
          data.responseKeyId,
        );
      }
    };

    const writeRequest = (type: string, taskId: string): void => {
      const request = createSignedIpcRequestEnvelope(auth.authToken, {
        type,
        taskId,
        appId,
        agentId,
        chatJid: conversationId,
        targetJid: conversationId,
        context: { appId, agentId, responseKeyId: auth.responseKeyId },
        payload: type === 'delegate_task' ? { objective: 'Investigate' } : {},
      });
      fs.writeFileSync(
        path.join(
          controlPort.requestDir(sourceAgentFolder, 'tasks'),
          `${taskId}.json`,
        ),
        JSON.stringify(request),
      );
    };

    writeRequest('delegate_task', 'parent-delegation');
    startIpcWatcher({
      conversationRoutes: () => ({
        [conversationId]: {
          name: 'Orchestrator',
          folder: sourceAgentFolder,
          trigger: '',
          added_at: new Date(0).toISOString(),
        },
      }),
    } as never);

    await delegationStarted;
    writeRequest('task_get', 'callee-task-get');
    const calleeResponse = taskIpcResponsePath(
      sourceAgentFolder,
      'callee-task-get',
    );
    await vi.waitFor(() => expect(fs.existsSync(calleeResponse)).toBe(true), {
      timeout: 1_000,
    });
    expect(
      fs.existsSync(
        taskIpcResponsePath(sourceAgentFolder, 'parent-delegation'),
      ),
    ).toBe(false);

    releaseDelegation();
    await vi.waitFor(
      () =>
        expect(
          fs.existsSync(
            taskIpcResponsePath(sourceAgentFolder, 'parent-delegation'),
          ),
        ).toBe(true),
      { timeout: 1_000 },
    );
  });
});
