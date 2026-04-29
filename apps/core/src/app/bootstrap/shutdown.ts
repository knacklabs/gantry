import { closeAllBrowsers } from '../../runtime/browser-capability.js';
import { logger } from '../../infrastructure/logging/logger.js';

interface ShutdownDeps {
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  exit: (code: number) => never;
  closeAllBrowsers: typeof closeAllBrowsers;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

interface ShutdownQueue {
  shutdown: (timeoutMs: number) => Promise<void>;
}

export interface InstallShutdownHandlersOptions {
  queue: ShutdownQueue;
  disconnectChannels: () => Promise<void>;
  closeStorage?: () => Promise<void>;
  closeControlServer?: () => Promise<void>;
  closeScheduler?: () => Promise<void>;
}

function makeDefaultDeps(): ShutdownDeps {
  return {
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    exit: (code: number) => process.exit(code),
    closeAllBrowsers,
    logger,
  };
}

export function installShutdownHandlers(
  options: InstallShutdownHandlersOptions,
  deps: Partial<ShutdownDeps> = {},
): void {
  const resolved: ShutdownDeps = {
    ...makeDefaultDeps(),
    ...deps,
  };

  const shutdown = async (signal: string) => {
    resolved.logger.info({ signal }, 'Shutdown signal received');
    await options.queue.shutdown(10000);
    await resolved.closeAllBrowsers();
    await options.disconnectChannels();
    if (options.closeControlServer) {
      try {
        await options.closeControlServer();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to close control server during shutdown',
        );
      }
    }
    if (options.closeScheduler) {
      try {
        await options.closeScheduler();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to close scheduler during shutdown',
        );
      }
    }
    if (options.closeStorage) {
      try {
        await options.closeStorage();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to close runtime storage during shutdown',
        );
      }
    }
    resolved.exit(0);
  };

  resolved.onSignal('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  resolved.onSignal('SIGINT', () => {
    void shutdown('SIGINT');
  });
}
