import { describe, expect, it, vi } from 'vitest';

import { installShutdownHandlers } from '@core/app/bootstrap/shutdown.js';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('installShutdownHandlers', () => {
  it('drains in a deterministic order: mark draining, stop intake, release host lease early, await deadline, then teardown', async () => {
    const order: string[] = [];
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();

    const queue = {
      shutdown: vi.fn(async (timeoutMs: number) => {
        expect(timeoutMs).toBe(90000);
        order.push('queue.shutdown');
      }),
    };

    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
      return undefined as never;
    });

    installShutdownHandlers(
      {
        queue,
        drainDeadlineMs: 90000,
        closeScheduler: vi.fn(async () => {
          order.push('closeScheduler');
        }),
        closeLiveTurnAdmission: vi.fn(() => {
          order.push('closeLiveTurnAdmission');
        }),
        closeMessagePolling: vi.fn(() => {
          order.push('closeMessagePolling');
        }),
        closeLiveTurnRecovery: vi.fn(async () => {
          order.push('closeLiveTurnRecovery');
        }),
        closeLiveRecoveryCoordinatorLease: vi.fn(async () => {
          order.push('closeLiveRecoveryCoordinatorLease');
        }),
        closeBrowserToolBackends: vi.fn(async () => {
          order.push('closeBrowserToolBackends');
        }),
        closeControlServer: vi.fn(async () => {
          order.push('closeControlServer');
        }),
        closeOutboundDeliveryRecovery: vi.fn(async () => {
          order.push('closeOutboundDeliveryRecovery');
        }),
        closeLiveTurnAuthority: vi.fn(async () => {
          order.push('closeLiveTurnAuthority');
        }),
        closeSettingsWatcher: vi.fn(() => {
          order.push('closeSettingsWatcher');
        }),
        closeStorage: vi.fn(async () => {
          order.push('closeStorage');
        }),
        disconnectChannels: vi.fn(async () => {
          order.push('disconnectChannels');
        }),
      },
      {
        onSignal: (signal, handler) => {
          handlers.set(signal, handler);
        },
        markDraining: vi.fn(() => {
          order.push('markDraining');
        }),
        closeAllBrowsers: vi.fn(async () => {
          order.push('closeAllBrowsers');
        }),
        logger: {
          info: vi.fn(() => {
            order.push('log-signal');
          }),
          warn: vi.fn(),
        },
        exit: exit as never,
      },
    );

    handlers.get('SIGTERM')?.();
    await flushPromises();

    expect(order).toEqual([
      'log-signal',
      'markDraining',
      'closeScheduler',
      'closeLiveTurnAdmission',
      'closeMessagePolling',
      'closeLiveTurnRecovery',
      'closeLiveRecoveryCoordinatorLease',
      'queue.shutdown',
      'closeBrowserToolBackends',
      'closeAllBrowsers',
      'disconnectChannels',
      'closeControlServer',
      'closeOutboundDeliveryRecovery',
      'closeLiveTurnAuthority',
      'closeSettingsWatcher',
      'closeStorage',
      'exit:0',
    ]);
  });

  it('marks draining and releases the host lease before awaiting the deadline', async () => {
    const order: string[] = [];
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();

    installShutdownHandlers(
      {
        queue: {
          shutdown: vi.fn(async () => {
            order.push('queue.shutdown');
          }),
        },
        drainDeadlineMs: 120000,
        closeLiveRecoveryCoordinatorLease: vi.fn(async () => {
          order.push('release-host-lease');
        }),
        disconnectChannels: vi.fn(async () => {}),
      },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        markDraining: vi.fn(() => order.push('markDraining')),
        closeAllBrowsers: vi.fn(async () => {}),
        logger: { info: vi.fn(), warn: vi.fn() },
        exit: vi.fn(() => undefined as never),
      },
    );

    handlers.get('SIGINT')?.();
    await flushPromises();

    expect(order.indexOf('markDraining')).toBeLessThan(
      order.indexOf('release-host-lease'),
    );
    expect(order.indexOf('release-host-lease')).toBeLessThan(
      order.indexOf('queue.shutdown'),
    );
  });

  it('still exits when the drain deadline overruns (queue.shutdown bounded by deadline)', async () => {
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();
    let observedDeadline = -1;
    const exit = vi.fn(() => undefined as never);

    installShutdownHandlers(
      {
        queue: {
          // Simulates queue.shutdown returning after its own deadline-bounded
          // wait; the process must proceed to exit regardless of overrun.
          shutdown: vi.fn(async (timeoutMs: number) => {
            observedDeadline = timeoutMs;
          }),
        },
        drainDeadlineMs: 5000,
        disconnectChannels: vi.fn(async () => {}),
      },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        markDraining: vi.fn(),
        closeAllBrowsers: vi.fn(async () => {}),
        logger: { info: vi.fn(), warn: vi.fn() },
        exit: exit as never,
      },
    );

    handlers.get('SIGTERM')?.();
    await flushPromises();

    expect(observedDeadline).toBe(5000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('continues draining when a teardown step throws', async () => {
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();
    const warn = vi.fn();
    const exit = vi.fn(() => undefined as never);

    installShutdownHandlers(
      {
        queue: { shutdown: vi.fn(async () => {}) },
        drainDeadlineMs: 120000,
        closeScheduler: vi.fn(async () => {
          throw new Error('scheduler boom');
        }),
        closeStorage: vi.fn(async () => {}),
        disconnectChannels: vi.fn(async () => {}),
      },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        markDraining: vi.fn(),
        closeAllBrowsers: vi.fn(async () => {}),
        logger: { info: vi.fn(), warn },
        exit: exit as never,
      },
    );

    handlers.get('SIGTERM')?.();
    await flushPromises();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to stop scheduler during drain',
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits when queue or channel shutdown rejects', async () => {
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();
    const warn = vi.fn();
    const exit = vi.fn(() => undefined as never);

    installShutdownHandlers(
      {
        queue: {
          shutdown: vi.fn(async () => {
            throw new Error('queue boom');
          }),
        },
        drainDeadlineMs: 120000,
        disconnectChannels: vi.fn(async () => {
          throw new Error('channel boom');
        }),
      },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        markDraining: vi.fn(),
        closeAllBrowsers: vi.fn(async () => {
          throw new Error('browser boom');
        }),
        logger: { info: vi.fn(), warn },
        exit: exit as never,
      },
    );

    handlers.get('SIGTERM')?.();
    await flushPromises();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to shutdown runtime queue during drain',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to close active browser sessions during shutdown',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to disconnect channels during shutdown',
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('drains exactly once when SIGTERM and SIGINT both fire', async () => {
    const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>();
    const queueShutdown = vi.fn(async () => {});
    const closeStorage = vi.fn(async () => {});
    const exit = vi.fn(() => undefined as never);

    installShutdownHandlers(
      {
        queue: { shutdown: queueShutdown },
        drainDeadlineMs: 90000,
        closeStorage,
        disconnectChannels: vi.fn(async () => {}),
      },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        markDraining: vi.fn(),
        closeAllBrowsers: vi.fn(async () => {}),
        logger: { info: vi.fn(), warn: vi.fn() },
        exit: exit as never,
      },
    );

    // Container orchestration commonly delivers SIGTERM then SIGINT.
    handlers.get('SIGTERM')?.();
    handlers.get('SIGINT')?.();
    await flushPromises();

    expect(queueShutdown).toHaveBeenCalledTimes(1);
    expect(closeStorage).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
