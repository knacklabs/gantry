import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import { computeIpcAuthToken } from '@core/runtime/ipc-auth.js';
import { parseTaskIpcData } from '@core/runtime/ipc-task-parsing.js';

it('rejects removed scheduler IPC fields as generic unsupported fields', () => {
  for (const field of ['required_tools', 'group_scope']) {
    const payload = {
      requestId: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      context: { responseKeyId: 'test-response-key' },
      name: 'Job',
      prompt: 'Run',
      scheduleType: 'interval',
      scheduleValue: '60000',
      executionContext: {
        conversationJid: 'tg:team',
        threadId: null,
        workspaceKey: 'team',
      },
      [field]: 'unused',
    };
    const signed = {
      ...payload,
      signature: signIpcRequestPayload(computeIpcAuthToken('team'), payload),
    };

    expect(() => parseTaskIpcData(signed, 'team')).toThrow(
      `Unsupported scheduler job fields: ${field}.`,
    );
  }
});
