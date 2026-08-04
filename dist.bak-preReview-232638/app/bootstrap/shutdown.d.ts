import { closeAllBrowsers } from '../../runtime/browser-capability.js';
import { logger } from '../../infrastructure/logging/logger.js';
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
    closeAsyncTaskRecovery?: () => Promise<void>;
    /** Stop admitting NEW live turns (active turns keep running). */
    closeLiveTurnAdmission?: () => void;
    /** Stop the live admission loop so no new run rows are created. */
    closeLiveAdmissionLoop?: (timeoutMs: number) => Promise<void> | void;
    closeLiveTurnAuthority?: () => Promise<void>;
    closeSettingsWatcher?: () => void;
    closeTracing?: () => Promise<void>;
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
export declare function installShutdownHandlers(options: InstallShutdownHandlersOptions, deps?: Partial<ShutdownDeps>): void;
export {};
