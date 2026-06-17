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
  closeOutboundDeliveryRecovery?: () => Promise<void>;
  closeConversationWorkReconciler?: () => void;
  closeWorkerInventoryHeartbeat?: () => void;
  releaseConversationOwnerLeases?: () => Promise<void>;
  markConversationOwnerLeasesDraining?: () => Promise<void>;
  closeSettingsWatcher?: () => void;
  closeBrowserToolBackends?: () => Promise<void>;
  closeIpcSocketServer?: () => Promise<void>;
  closeEgressGateways?: () => Promise<void>;
  closeWarmPool?: () => Promise<void>;
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
  let shutdownStarted = false;

  const shutdown = async (signal: string) => {
    if (shutdownStarted) {
      resolved.logger.info(
        { signal },
        'Shutdown signal ignored because shutdown is already in progress',
      );
      return;
    }
    shutdownStarted = true;
    resolved.logger.info({ signal }, 'Shutdown signal received');
    options.closeConversationWorkReconciler?.();
    options.closeWorkerInventoryHeartbeat?.();
    await options.queue.shutdown(10000);
    if (options.releaseConversationOwnerLeases) {
      try {
        await options.releaseConversationOwnerLeases();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to release clean conversation owner leases during shutdown',
        );
      }
    }
    if (options.markConversationOwnerLeasesDraining) {
      try {
        await options.markConversationOwnerLeasesDraining();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to mark remaining conversation owner leases draining during shutdown',
        );
      }
    }
    if (options.closeIpcSocketServer) {
      try {
        await options.closeIpcSocketServer();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to stop IPC socket server during shutdown',
        );
      }
    }
    if (options.closeEgressGateways) {
      try {
        await options.closeEgressGateways();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to close egress gateways during shutdown',
        );
      }
    }
    if (options.closeWarmPool) {
      try {
        await options.closeWarmPool();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to close warm-pool workers during shutdown',
        );
      }
    }
    if (options.closeBrowserToolBackends) {
      try {
        await options.closeBrowserToolBackends();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to close browser tool backends during shutdown',
        );
      }
    }
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
    if (options.closeOutboundDeliveryRecovery) {
      try {
        await options.closeOutboundDeliveryRecovery();
      } catch (err) {
        resolved.logger.warn(
          { err },
          'Failed to stop outbound delivery recovery during shutdown',
        );
      }
    }
    options.closeSettingsWatcher?.();
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
