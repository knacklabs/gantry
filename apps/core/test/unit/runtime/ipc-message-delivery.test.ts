import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  dataDir: `/tmp/gantry-ipc-message-delivery-${process.pid}`,
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: testState.dataDir,
  IPC_POLL_INTERVAL: 5,
}));

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import { canProcessIpcFile } from '@core/runtime/ipc-rate-limit.js';
import { verifyIpcResponsePayload } from '@core/infrastructure/ipc/response-signing.js';
import { startIpcWatcher, stopIpcWatcher } from '@core/runtime/ipc.js';

const sourceAgentFolder = 'delivery_agent';
const targetJid = 'tg:delivery';
const scope = { appId: 'app:test', agentId: 'agent:delivery' };
const controlPort = new FilesystemRunnerControlPort(
  path.join(testState.dataDir, 'ipc'),
);

function writeMessageRequest(taskId: string): {
  responseVerifyKey: string;
} {
  const auth = createIpcAuthEnvelope(sourceAgentFolder, null, scope);
  const envelope = createSignedIpcRequestEnvelope(auth.authToken, {
    type: 'message',
    taskId,
    chatJid: targetJid,
    text: 'hello',
    context: { ...scope, responseKeyId: auth.responseKeyId },
  });
  fs.writeFileSync(
    path.join(
      controlPort.requestDir(sourceAgentFolder, 'messages'),
      `${taskId}.json`,
    ),
    JSON.stringify(envelope),
  );
  return { responseVerifyKey: auth.responseVerifyKey };
}

function startWatcher(sendMessage: () => Promise<void>): void {
  startIpcWatcher({
    conversationRoutes: () => ({
      [targetJid]: {
        name: 'Delivery agent',
        folder: sourceAgentFolder,
        trigger: '',
        added_at: new Date(0).toISOString(),
      },
    }),
    sendMessage,
  } as never);
}

async function readSignedResponse(
  taskId: string,
  responseVerifyKey: string,
): Promise<Record<string, unknown>> {
  const responsePath = path.join(
    testState.dataDir,
    'ipc',
    sourceAgentFolder,
    'task-responses',
    `task-${taskId}.json`,
  );
  await vi.waitFor(() => expect(fs.existsSync(responsePath)).toBe(true));
  const { signature, ...payload } = JSON.parse(
    fs.readFileSync(responsePath, 'utf-8'),
  ) as Record<string, unknown> & { signature?: string };
  expect(verifyIpcResponsePayload(responseVerifyKey, payload, signature)).toBe(
    true,
  );
  return payload;
}

describe('IPC message delivery result', () => {
  beforeEach(() => {
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
    controlPort.ensureRoot();
    controlPort.ensureWorkspaceLayout(sourceAgentFolder);
  });

  afterEach(() => {
    stopIpcWatcher();
    vi.useRealTimers();
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
  });

  it('answers the runner with the channel failure when delivery throws', async () => {
    const { responseVerifyKey } = writeMessageRequest('send-fails');
    startWatcher(
      vi.fn(async () => {
        throw new Error('channel is offline');
      }),
    );

    await expect(
      readSignedResponse('send-fails', responseVerifyKey),
    ).resolves.toMatchObject({ ok: false, error: 'channel is offline' });
  });

  it('answers the runner with ok once the channel accepts the message', async () => {
    const { responseVerifyKey } = writeMessageRequest('send-works');
    const sendMessage = vi.fn(async () => undefined);
    startWatcher(sendMessage);

    await expect(
      readSignedResponse('send-works', responseVerifyKey),
    ).resolves.toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps an over-quota message waiting and delivers it after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    while (canProcessIpcFile(sourceAgentFolder, 'messages')) {
      // use up this minute's quota
    }
    writeMessageRequest('send-later');
    const sendMessage = vi.fn(async () => undefined);
    startWatcher(sendMessage);

    // Several watcher polls (5 ms each) run on the fake clock.
    await vi.advanceTimersByTimeAsync(50);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(controlPort.requestDir(sourceAgentFolder, 'messages')),
    ).toEqual(['send-later.json']);
    const errorsDir = path.join(testState.dataDir, 'ipc', 'errors');
    expect(fs.existsSync(errorsDir) ? fs.readdirSync(errorsDir) : []).toEqual(
      [],
    );

    vi.setSystemTime(Date.now() + 61_000);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });
});
