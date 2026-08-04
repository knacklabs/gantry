import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  dataDir: `/tmp/gantry-ipc-operational-errors-${process.pid}`,
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: testState.dataDir,
  IPC_POLL_INTERVAL: 5,
}));

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { computeIpcAuthToken } from '@core/runtime/ipc-auth.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import { getOperationalErrorCount } from '@core/shared/operational-error-counters.js';
import { startIpcWatcher, stopIpcWatcher } from '@core/runtime/ipc.js';
import { processMemoryRequest } from '@core/memory/memory-ipc.js';

describe('IPC operational error counters', () => {
  beforeEach(() => {
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    stopIpcWatcher();
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
  });

  it('increments message dispatch once when delivery is archived as failed', async () => {
    const sourceAgentFolder = 'counter_agent';
    const targetJid = 'tg:counter';
    const controlPort = new FilesystemRunnerControlPort(
      path.join(testState.dataDir, 'ipc'),
    );
    controlPort.ensureRoot();
    controlPort.ensureWorkspaceLayout(sourceAgentFolder);
    const payload = createSignedIpcRequestEnvelope(
      computeIpcAuthToken(sourceAgentFolder, undefined, {
        appId: 'app:test',
        agentId: 'agent:counter',
      }),
      {
        type: 'message',
        requestId: 'message-dispatch-failure',
        chatJid: targetJid,
        text: 'fail this delivery',
        context: { appId: 'app:test', agentId: 'agent:counter' },
      },
    );
    fs.writeFileSync(
      path.join(
        controlPort.requestDir(sourceAgentFolder, 'messages'),
        'message-dispatch-failure.json',
      ),
      JSON.stringify(payload),
    );
    const before = getOperationalErrorCount('ipc', 'message_dispatch');

    startIpcWatcher({
      conversationRoutes: () => ({
        [targetJid]: {
          name: 'Counter agent',
          folder: sourceAgentFolder,
          trigger: '',
          added_at: new Date(0).toISOString(),
        },
      }),
      sendMessage: vi.fn(async () => {
        throw new Error('simulated channel failure');
      }),
    } as never);

    await vi.waitFor(() => {
      expect(getOperationalErrorCount('ipc', 'message_dispatch')).toBe(
        before + 1,
      );
    });
  });

  it('increments memory IPC once when a failure becomes an error response', async () => {
    const before = getOperationalErrorCount('memory', 'ipc_request');

    await expect(
      processMemoryRequest(
        {
          requestId: 'memory-request-failure',
          action: 'memory_search',
          payload: { query: '' },
          allowedActions: ['memory_search'],
        },
        'counter_agent',
      ),
    ).resolves.toMatchObject({ ok: false, error: 'query is required' });
    expect(getOperationalErrorCount('memory', 'ipc_request')).toBe(before + 1);
  });
});
