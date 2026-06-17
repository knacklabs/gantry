import { describe, expect, it, vi } from 'vitest';

import { installShutdownHandlers } from '@core/app/bootstrap/shutdown.js';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('installShutdownHandlers', () => {
  it('preserves shutdown order', async () => {
    const order: string[] = [];
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();

    const queue = {
      shutdown: vi.fn(async (timeoutMs: number) => {
        expect(timeoutMs).toBe(10000);
        order.push('queue.shutdown');
      }),
    };

    const channelA = {
      disconnect: vi.fn(async () => {
        order.push('channel-a.disconnect');
      }),
    };

    const channelB = {
      disconnect: vi.fn(async () => {
        order.push('channel-b.disconnect');
      }),
    };

    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
      return undefined as never;
    });

    installShutdownHandlers(
      {
        queue,
        closeWarmPool: vi.fn(async () => {
          order.push('closeWarmPool');
        }),
        closeBrowserToolBackends: vi.fn(async () => {
          order.push('closeBrowserToolBackends');
        }),
        closeIpcSocketServer: vi.fn(async () => {
          order.push('closeIpcSocketServer');
        }),
        closeEgressGateways: vi.fn(async () => {
          order.push('closeEgressGateways');
        }),
        closeConversationWorkReconciler: vi.fn(() => {
          order.push('closeConversationWorkReconciler');
        }),
        closeWorkerInventoryHeartbeat: vi.fn(() => {
          order.push('closeWorkerInventoryHeartbeat');
        }),
        releaseConversationOwnerLeases: vi.fn(async () => {
          order.push('releaseConversationOwnerLeases');
        }),
        markConversationOwnerLeasesDraining: vi.fn(async () => {
          order.push('markConversationOwnerLeasesDraining');
        }),
        closeStorage: vi.fn(async () => {
          order.push('closeStorage');
        }),
        disconnectChannels: vi.fn(async () => {
          await channelA.disconnect();
          await channelB.disconnect();
        }),
      },
      {
        onSignal: (signal, handler) => {
          handlers.set(signal, handler);
        },
        closeAllBrowsers: vi.fn(async () => {
          order.push('closeAllBrowsers');
        }),
        logger: {
          info: vi.fn(() => {
            order.push('log-signal');
          }),
        },
        exit: exit as any,
      },
    );

    handlers.get('SIGTERM')?.();
    await flushPromises();

    expect(order).toEqual([
      'log-signal',
      'closeConversationWorkReconciler',
      'closeWorkerInventoryHeartbeat',
      'queue.shutdown',
      'releaseConversationOwnerLeases',
      'markConversationOwnerLeasesDraining',
      'closeIpcSocketServer',
      'closeEgressGateways',
      'closeWarmPool',
      'closeBrowserToolBackends',
      'closeAllBrowsers',
      'channel-a.disconnect',
      'channel-b.disconnect',
      'closeStorage',
      'exit:0',
    ]);
  });

  it('ignores duplicate shutdown signals while cleanup is in flight', async () => {
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();
    let resolveQueueShutdown: (() => void) | undefined;
    const queue = {
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveQueueShutdown = resolve;
          }),
      ),
    };
    const closeIpcSocketServer = vi.fn(async () => undefined);
    const exit = vi.fn(() => undefined as never);

    installShutdownHandlers(
      {
        queue,
        disconnectChannels: vi.fn(async () => undefined),
        closeIpcSocketServer,
      },
      {
        onSignal: (signal, handler) => {
          handlers.set(signal, handler);
        },
        closeAllBrowsers: vi.fn(async () => undefined),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
        exit: exit as any,
      },
    );

    handlers.get('SIGINT')?.();
    handlers.get('SIGTERM')?.();
    await flushPromises();

    expect(queue.shutdown).toHaveBeenCalledTimes(1);
    expect(closeIpcSocketServer).not.toHaveBeenCalled();

    resolveQueueShutdown?.();
    await flushPromises();

    expect(closeIpcSocketServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
