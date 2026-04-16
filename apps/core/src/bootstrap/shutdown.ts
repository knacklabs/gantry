import { closeAllBrowsers } from '../runtime/browser-manager.js';
import { logger } from '../core/logger.js';
import { Channel } from '../core/types.js';

interface ShutdownDeps {
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  exit: (code: number) => never;
  closeAllBrowsers: typeof closeAllBrowsers;
  logger: Pick<typeof logger, 'info'>;
}

interface ShutdownQueue {
  shutdown: (timeoutMs: number) => Promise<void>;
}

interface MiniAppServerLike {
  close: () => Promise<void>;
}

export interface InstallShutdownHandlersOptions {
  queue: ShutdownQueue;
  channels: Channel[];
  miniAppServer: MiniAppServerLike | null;
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
    if (options.miniAppServer) {
      await options.miniAppServer.close();
    }
    for (const channel of options.channels) {
      await channel.disconnect();
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
