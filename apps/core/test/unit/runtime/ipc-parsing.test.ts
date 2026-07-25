import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ipcTestState = vi.hoisted(() => ({
  dataDir: `/tmp/gantry-ipc-cancellation-${process.pid}`,
  finishPermissionProcessing: undefined as (() => void) | undefined,
  finishQuestionProcessing: undefined as (() => void) | undefined,
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: ipcTestState.dataDir,
  IPC_POLL_INTERVAL: 5,
}));

vi.mock(
  '@core/runtime/ipc-interaction-processing.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@core/runtime/ipc-interaction-processing.js')
      >();
    return {
      ...actual,
      processPermissionInteractionIpc: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            ipcTestState.finishPermissionProcessing = resolve;
          }),
      ),
      processUserQuestionInteractionIpc: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            ipcTestState.finishQuestionProcessing = resolve;
          }),
      ),
    };
  },
);

vi.mock('@core/runtime/ipc-request-wakeup-registry.js', () => ({
  IpcRequestWakeupRegistry: class {
    reconcile(): void {}
    stop(): void {}
  },
}));

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import {
  parsePermissionCancellationIpcRequest,
  parsePermissionIpcRequest,
  parseQuestionCancellationIpcRequest,
} from '@core/runtime/ipc-parsing.js';
import { startIpcWatcher, stopIpcWatcher } from '@core/runtime/ipc.js';

function permissionEnvelope(
  permissionLane: unknown,
  expiresAt?: string,
): Record<string, unknown> {
  const auth = createIpcAuthEnvelope('team', undefined, {
    appId: 'default',
    agentId: 'agent:team',
  });
  return createSignedIpcRequestEnvelope(
    auth.authToken,
    {
      requestId: `perm-lane-${randomUUID()}`,
      sourceAgentFolder: 'team',
      toolName: 'Bash',
      permissionLane,
      ...(expiresAt ? { expiresAt } : {}),
      context: {
        appId: 'default',
        agentId: 'agent:team',
        responseKeyId: auth.responseKeyId,
      },
    },
    { separateAuthExpiry: true },
  );
}

describe('parsePermissionIpcRequest', () => {
  afterEach(() => {
    ipcTestState.finishPermissionProcessing?.();
    ipcTestState.finishPermissionProcessing = undefined;
    ipcTestState.finishQuestionProcessing?.();
    ipcTestState.finishQuestionProcessing = undefined;
    stopIpcWatcher();
    clearConsumedIpcRequestIds({ durable: 'consumed' });
    fs.rmSync(ipcTestState.dataDir, { recursive: true, force: true });
  });

  it.each([
    ['interactive', 'interactive'],
    [' autonomous ', 'autonomous'],
  ] as const)(
    'preserves a signed %s permission lane',
    (rawPermissionLane, permissionLane) => {
      expect(
        parsePermissionIpcRequest(
          permissionEnvelope(rawPermissionLane),
          'team',
        ),
      ).toMatchObject({ permissionLane });
    },
  );

  it('rejects an unknown permission lane', () => {
    expect(() =>
      parsePermissionIpcRequest(permissionEnvelope('scheduled'), 'team'),
    ).toThrow('Invalid permission IPC permissionLane');
  });

  it('preserves the runner lifecycle deadline and omits it for an unbounded request', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(
      parsePermissionIpcRequest(
        permissionEnvelope('interactive', expiresAt),
        'team',
      ),
    ).toMatchObject({ expiresAt });
    expect(
      parsePermissionIpcRequest(permissionEnvelope('interactive'), 'team'),
    ).not.toHaveProperty('expiresAt');
  });

  it('parses a signed cancellation against the original permission request id', () => {
    const auth = createIpcAuthEnvelope('team', 'thread-1', {
      appId: 'default',
      agentId: 'agent:team',
    });
    const permissionRequestId = `perm-${randomUUID()}`;
    const raw = createSignedIpcRequestEnvelope(auth.authToken, {
      requestId: `perm-cancel-${randomUUID()}`,
      permissionRequestId,
      appId: 'default',
      sourceAgentFolder: 'team',
      reason: 'Permission request cancelled.',
      context: {
        appId: 'default',
        agentId: 'agent:team',
        threadId: 'thread-1',
      },
    });

    expect(parsePermissionCancellationIpcRequest(raw, 'team')).toEqual({
      requestId: permissionRequestId,
      appId: 'default',
      sourceAgentFolder: 'team',
      threadId: 'thread-1',
      reason: 'Permission request cancelled.',
    });
  });

  it('routes a claimed request cancellation to the host permission waiter', async () => {
    const sourceAgentFolder = 'team';
    const targetJid = 'tg:team';
    const controlPort = new FilesystemRunnerControlPort(
      path.join(ipcTestState.dataDir, 'ipc'),
    );
    controlPort.ensureRoot();
    controlPort.ensureWorkspaceLayout(sourceAgentFolder);
    const auth = createIpcAuthEnvelope(sourceAgentFolder, 'thread-1', {
      appId: 'default',
      agentId: 'agent:team',
    });
    const permissionRequestId = `perm-${randomUUID()}`;
    const permission = createSignedIpcRequestEnvelope(
      auth.authToken,
      {
        requestId: permissionRequestId,
        responseNonce: randomUUID(),
        appId: 'default',
        sourceAgentFolder,
        targetJid,
        threadId: 'thread-1',
        toolName: 'Bash',
        permissionLane: 'interactive',
        context: {
          appId: 'default',
          agentId: 'agent:team',
          chatJid: targetJid,
          threadId: 'thread-1',
          responseKeyId: auth.responseKeyId,
        },
      },
      { separateAuthExpiry: true },
    );
    const cancellation = createSignedIpcRequestEnvelope(auth.authToken, {
      requestId: `perm-cancel-${randomUUID()}`,
      permissionRequestId,
      appId: 'default',
      sourceAgentFolder,
      threadId: 'thread-1',
      reason: 'Permission request cancelled.',
      context: {
        appId: 'default',
        agentId: 'agent:team',
        threadId: 'thread-1',
      },
    });
    fs.writeFileSync(
      path.join(
        controlPort.requestDir(sourceAgentFolder, 'permission-requests'),
        `${permissionRequestId}.json`,
      ),
      JSON.stringify(permission),
    );
    fs.writeFileSync(
      path.join(
        controlPort.requestDir(sourceAgentFolder, 'permission-cancellations'),
        `${permissionRequestId}.json`,
      ),
      JSON.stringify(cancellation),
    );
    const cancelPermissionApproval = vi.fn(async () => 'settled' as const);

    startIpcWatcher({
      conversationRoutes: () => ({
        [targetJid]: {
          name: 'Team',
          folder: sourceAgentFolder,
          trigger: '',
          added_at: new Date(0).toISOString(),
        },
      }),
      cancelPermissionApproval,
    } as never);

    await vi.waitFor(() =>
      expect(cancelPermissionApproval).toHaveBeenCalledWith({
        requestId: permissionRequestId,
        appId: 'default',
        sourceAgentFolder,
        threadId: 'thread-1',
        reason: 'Permission request cancelled.',
      }),
    );
    expect(
      fs.readdirSync(
        controlPort.requestDir(sourceAgentFolder, 'permission-cancellations'),
      ),
    ).toEqual([]);
  });

  it('parses and routes a claimed question cancellation to the host question waiter', async () => {
    const sourceAgentFolder = 'team';
    const targetJid = 'tg:team';
    const controlPort = new FilesystemRunnerControlPort(
      path.join(ipcTestState.dataDir, 'ipc'),
    );
    controlPort.ensureRoot();
    controlPort.ensureWorkspaceLayout(sourceAgentFolder);
    const auth = createIpcAuthEnvelope(sourceAgentFolder, 'thread-1', {
      appId: 'default',
      agentId: 'agent:team',
    });
    const questionRequestId = `userq-${randomUUID()}`;
    const question = createSignedIpcRequestEnvelope(
      auth.authToken,
      {
        requestId: questionRequestId,
        sourceAgentFolder,
        questions: [
          {
            question: 'Continue?',
            header: 'Continue',
            options: [
              { label: 'Yes', description: 'Proceed' },
              { label: 'No', description: 'Wait' },
            ],
            multiSelect: false,
          },
        ],
        context: {
          appId: 'default',
          agentId: 'agent:team',
          chatJid: targetJid,
          threadId: 'thread-1',
          responseKeyId: auth.responseKeyId,
        },
      },
      { separateAuthExpiry: true },
    );
    const cancellation = createSignedIpcRequestEnvelope(auth.authToken, {
      requestId: `userq-cancel-${randomUUID()}`,
      questionRequestId,
      appId: 'default',
      sourceAgentFolder,
      reason: 'Question cancelled. Nothing changed.',
      context: {
        appId: 'default',
        agentId: 'agent:team',
        threadId: 'thread-1',
      },
    });

    expect(parseQuestionCancellationIpcRequest(cancellation, 'team')).toEqual({
      requestId: questionRequestId,
      appId: 'default',
      sourceAgentFolder: 'team',
      threadId: 'thread-1',
      reason: 'Question cancelled. Nothing changed.',
    });
    clearConsumedIpcRequestIds({ durable: 'consumed' });

    fs.writeFileSync(
      path.join(
        controlPort.requestDir(sourceAgentFolder, 'user-questions'),
        `${questionRequestId}.json`,
      ),
      JSON.stringify(question),
    );
    fs.writeFileSync(
      path.join(
        controlPort.requestDir(sourceAgentFolder, 'question-cancellations'),
        `${questionRequestId}.json`,
      ),
      JSON.stringify(cancellation),
    );
    const cancelUserQuestion = vi.fn(async () => 'settled' as const);

    startIpcWatcher({
      conversationRoutes: () => ({
        [targetJid]: {
          name: 'Team',
          folder: sourceAgentFolder,
          trigger: '',
          added_at: new Date(0).toISOString(),
        },
      }),
      cancelUserQuestion,
    } as never);

    await vi.waitFor(() =>
      expect(cancelUserQuestion).toHaveBeenCalledWith({
        requestId: questionRequestId,
        appId: 'default',
        sourceAgentFolder,
        threadId: 'thread-1',
        reason: 'Question cancelled. Nothing changed.',
      }),
    );
    expect(
      fs.readdirSync(
        controlPort.requestDir(sourceAgentFolder, 'question-cancellations'),
      ),
    ).toEqual([]);
  });
});
