import { describe, expect, it, vi } from 'vitest';

import { installShutdownHandlers } from './shutdown.js';

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
      'queue.shutdown',
      'closeAllBrowsers',
      'channel-a.disconnect',
      'channel-b.disconnect',
      'exit:0',
    ]);
  });
});
