import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  dataDir: `/tmp/gantry-task-ipc-operational-errors-${process.pid}`,
  failingHandler: vi.fn(async () => {
    throw new Error('simulated task handler failure');
  }),
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: testState.dataDir,
}));

vi.mock('@core/jobs/ipc-admin-handlers.js', () => ({
  adminTaskHandlers: {
    simulated_failure: testState.failingHandler,
  },
}));

import { processTaskIpc } from '@core/jobs/ipc-handler.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { getOperationalErrorCount } from '@core/shared/operational-error-counters.js';

afterAll(() => {
  fs.rmSync(testState.dataDir, { recursive: true, force: true });
});

describe('task IPC operational error counter', () => {
  it('increments task dispatch once when a handler failure becomes an error response', async () => {
    fs.rmSync(testState.dataDir, { recursive: true, force: true });
    const before = getOperationalErrorCount('ipc', 'task_dispatch');
    const responseKeyId = createIpcAuthEnvelope('counter_agent').responseKeyId;

    await processTaskIpc(
      {
        taskId: 'task-dispatch-failure',
        type: 'simulated_failure',
        chatJid: 'tg:counter',
        responseKeyId,
      } as never,
      'counter_agent',
      {
        conversationRoutes: () => ({
          'tg:counter': { folder: 'counter_agent' },
        }),
        opsRepository: {},
      } as never,
    );

    expect(testState.failingHandler).toHaveBeenCalledOnce();
    expect(getOperationalErrorCount('ipc', 'task_dispatch')).toBe(before + 1);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            testState.dataDir,
            'ipc',
            'counter_agent',
            'task-responses',
            'task-task-dispatch-failure.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      ok: false,
      code: 'internal_error',
      error: 'simulated task handler failure',
    });
  });
});
