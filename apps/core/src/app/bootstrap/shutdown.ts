import { closeAllBrowsers } from '../../runtime/browser-capability.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { markDraining } from './draining-state.js';

interface ShutdownDeps {
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  exit: (code: number) => never;
  closeAllBrowsers: typeof closeAllBrowsers;
  markDraining: () => void;
  logger: Pick<typeof logger, 'info' | 'warn'>;
}

interface ShutdownQueue {
  shutdown: (timeoutMs: number) => Promise<void>;
}

export interface InstallShutdownHandlersOptions {
  queue: ShutdownQueue;
  disconnectChannels: () => Promise<void>;
  /** Graceful-drain deadline for in-flight work before forced exit (ms). */
  drainDeadlineMs: number;
  closeStorage?: () => Promise<void>;
  closeControlServer?: () => Promise<void>;
  closeScheduler?: () => Promise<void>;
  closeOutboundDeliveryRecovery?: () => Promise<void>;
  closeLiveTurnRecovery?: () => Promise<void>;
  /** Stop admitting NEW live turns (active turns keep running). */
  closeLiveTurnAdmission?: () => void;
  /** Stop the live message polling loop so no new run rows are created. */
  closeMessagePolling?: () => void;
  closeLiveTurnAuthority?: () => Promise<void>;
  closeSettingsWatcher?: () => void;
  /** Release the live-recovery-coordinator lease EARLY so a successor can take over. */
  closeLiveRecoveryCoordinatorLease?: () => Promise<void>;
  /**
   * Stop fleet worker subsystems (bake queue, capability reconciler, settings
   * revision listener) after intake stops, so their background timers/LISTEN
   * clients are torn down before exit. No-op in workstation mode.
   */
  closeFleetSubsystems?: () => Promise<void>;
  closeBrowserToolBackends?: () => Promise<void>;
}

function makeDefaultDeps(): ShutdownDeps {
  return {
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    exit: (code: number) => process.exit(code),
    closeAllBrowsers,
    markDraining,
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

  const runStep = async (
    step: (() => Promise<void> | void) | undefined,
    failureMessage: string,
  ): Promise<void> => {
    if (!step) return;
    try {
      await step();
    } catch (err) {
      resolved.logger.warn({ err }, failureMessage);
    }
  };

  const shutdown = async (signal: string) => {
    resolved.logger.info({ signal }, 'Shutdown signal received');

    // 1. Mark draining so /readyz goes red (ALB pulls this instance) and
    //    /metrics exports gantry_draining=1.
    resolved.markDraining();

    // 2. Stop intake: stop claiming new pg-boss work, stop admitting new live
    //    turns, stop polling for live messages (no more throwaway run rows),
    //    and stop the recovery sweep. In-flight work continues.
    await runStep(
      options.closeScheduler,
      'Failed to stop scheduler during drain',
    );
    options.closeLiveTurnAdmission?.();
    options.closeMessagePolling?.();
    await runStep(
      options.closeLiveTurnRecovery,
      'Failed to stop live-turn recovery during drain',
    );

    // Stop fleet worker subsystems once intake has stopped: the bake queue,
    // capability reconciler, and settings revision listener (background timers
    // and LISTEN clients) so nothing keeps the process alive after exit.
    await runStep(
      options.closeFleetSubsystems,
      'Failed to stop fleet subsystems during drain',
    );

    // 3. Release the live-recovery-coordinator lease EARLY so a successor can
    //    acquire it and recover any turn this worker cannot finish in time.
    await runStep(
      options.closeLiveRecoveryCoordinatorLease,
      'Failed to release live-recovery-coordinator lease during drain',
    );

    // 4. Stdin-close active live/message runs so they finish naturally, then
    //    wait for in-flight work up to the configured deadline before exit.
    await runStep(
      () => options.queue.shutdown(options.drainDeadlineMs),
      'Failed to shutdown runtime queue during drain',
    );

    // 5. Existing teardown steps, deterministic order. Scheduler, recovery
    //    sweep, and the host lease were already stopped/released above.
    await runStep(
      options.closeBrowserToolBackends,
      'Failed to close browser tool backends during shutdown',
    );
    await runStep(
      resolved.closeAllBrowsers,
      'Failed to close active browser sessions during shutdown',
    );
    await runStep(
      options.disconnectChannels,
      'Failed to disconnect channels during shutdown',
    );
    await runStep(
      options.closeControlServer,
      'Failed to close control server during shutdown',
    );
    await runStep(
      options.closeOutboundDeliveryRecovery,
      'Failed to stop outbound delivery recovery during shutdown',
    );
    await runStep(
      options.closeLiveTurnAuthority,
      'Failed to shutdown live-turn authority during shutdown',
    );
    options.closeSettingsWatcher?.();
    await runStep(
      options.closeStorage,
      'Failed to close runtime storage during shutdown',
    );
    resolved.exit(0);
  };

  // Container orchestration can deliver SIGTERM then SIGINT (or a duplicate
  // SIGTERM). Run the drain exactly once: the first signal owns the teardown,
  // later signals join the in-flight drain instead of racing a second one
  // through queue/storage/lease teardown.
  let shutdownPromise: Promise<void> | undefined;
  const shutdownOnce = (signal: string) => {
    if (!shutdownPromise) {
      shutdownPromise = shutdown(signal);
    }
    return shutdownPromise;
  };

  resolved.onSignal('SIGTERM', () => {
    void shutdownOnce('SIGTERM');
  });
  resolved.onSignal('SIGINT', () => {
    void shutdownOnce('SIGINT');
  });
}
