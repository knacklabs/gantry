import { describe, expect, it } from 'vitest';

import type {
  ConversationBindScope,
  WarmWorkerHandle,
} from '@core/application/agent-execution/warm-pool-capable.js';
import { makeSocketContinuationDelivery } from '@core/runtime/continuation-delivery.js';
import { makeSocketWarmBindDelivery } from '@core/runtime/warm-bind-delivery.js';
import type { IpcConnection } from '@core/shared/ipc-connection.js';

function makeHandle(): WarmWorkerHandle {
  return {
    id: 'worker-1',
    key: 'pool-key',
    bornAt: Date.now(),
    processName: 'worker-process',
    bound: false,
  };
}

function makeScope(): ConversationBindScope {
  return {
    groupFolder: 'boondi_support',
    appId: 'default',
    agentId: 'agent:boondi_support',
    chatJid: 'wa:000000001',
    sessionId: 'provider-session-existing',
    firstMessage: 'Do you have kaju katli?',
    runHandle: 'bound-run-1',
    ipcDir: '/tmp/ipc',
    ipcAuthToken: 'ipc-token',
    memoryIpcAuthToken: 'memory-token',
    ipcResponseKeyId: 'response-key',
    ipcResponseVerifyKey: 'verify-key',
  };
}

function makeConnection(input: {
  runHandle: string;
  sent: unknown[];
}): IpcConnection {
  return {
    scope: {
      sourceAgentFolder: 'boondi_support',
      role: 'runner',
      runHandle: input.runHandle,
    },
    send(frame: unknown) {
      input.sent.push(frame);
    },
  } as IpcConnection;
}

describe('makeSocketWarmBindDelivery', () => {
  it('waits briefly for the warm worker runner socket before delivering bind', async () => {
    const sent: unknown[] = [];
    const connections: IpcConnection[] = [];
    const delivery = makeSocketWarmBindDelivery(() => connections, {
      bindReadyTimeoutMs: 50,
      pollIntervalMs: 1,
    });

    setTimeout(() => {
      connections.push(makeConnection({ runHandle: 'worker-process', sent }));
    }, 5);

    await expect(delivery.deliver(makeHandle(), makeScope())).resolves.toBe(
      true,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        type: 'push',
        channel: 'bind',
        id: 'bind:bound-run-1',
        payload: expect.objectContaining({
          chatJid: 'wa:000000001',
          sessionId: 'provider-session-existing',
          firstMessage: 'Do you have kaju katli?',
          runHandle: 'bound-run-1',
        }),
      }),
    );
  });

  it('returns false when the matching runner socket never connects', async () => {
    const sent: unknown[] = [];
    const delivery = makeSocketWarmBindDelivery(
      () => [makeConnection({ runHandle: 'other-worker', sent })],
      {
        bindReadyTimeoutMs: 5,
        pollIntervalMs: 1,
      },
    );

    await expect(delivery.deliver(makeHandle(), makeScope())).resolves.toBe(
      false,
    );
    expect(sent).toHaveLength(0);
  });

  it('rekeys the runner socket to the bound run handle for follow-up continuations', async () => {
    const sent: unknown[] = [];
    const connections = [makeConnection({ runHandle: 'worker-process', sent })];
    const bindDelivery = makeSocketWarmBindDelivery(() => connections, {
      bindReadyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    const continuationDelivery = makeSocketContinuationDelivery(
      () => connections,
    );

    await expect(bindDelivery.deliver(makeHandle(), makeScope())).resolves.toBe(
      true,
    );

    expect(
      continuationDelivery.deliverContinuation(
        {
          groupFolder: 'boondi_support',
          chatJid: 'wa:000000001',
          threadId: null,
          runHandle: 'bound-run-1',
        },
        'follow up',
        0,
      ),
    ).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(
      expect.objectContaining({
        channel: 'continuation',
        payload: expect.objectContaining({ text: 'follow up' }),
      }),
    );
  });
});
