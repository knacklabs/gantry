import type { AppId } from '../domain/app/app.js';
import type { SettingsRevisionRepository } from '../domain/ports/fleet-capability-state.js';
import type { SettingsDesiredStateOps, SettingsDesiredStateRepositories } from '../config/settings/desired-state-service.js';
import type { EffectiveControlRuntimeSettings } from '../application/control-plane/control-plane-storage-model.js';
import type { SettingsRevisionWakeupSource } from '../config/settings/settings-revision-notify.js';
export interface SettingsRevisionSkewAlert {
    appId: string;
    revision: number;
    minReaderVersion: number;
    readerVersion: number;
}
export interface SettingsRevisionListenerDeps {
    appId: AppId;
    runtimeHome: string;
    settingsRevisions: SettingsRevisionRepository;
    ops: SettingsDesiredStateOps;
    repositories: SettingsDesiredStateRepositories;
    wakeupSource: SettingsRevisionWakeupSource;
    /** Reload in-process runtime state after applying a revision. */
    reloadRuntimeState: () => Promise<void>;
    pollIntervalMs?: number;
    readerVersion?: number;
    onSkewAlert?: (alert: SettingsRevisionSkewAlert) => void;
    /**
     * Invoked exactly once, after the FIRST revision is applied by this listener.
     * Fleet boot uses it to release services held while no desired state existed
     * (scheduler job claiming, capability subsystems). Never fired on skew-hold.
     * Errors are logged, not thrown — a failed deferred start must not poison
     * the applied revision.
     */
    onFirstRevisionApplied?: (settings: EffectiveControlRuntimeSettings) => Promise<void> | void;
    logWarn?: (context: Record<string, unknown>, message: string) => void;
    logInfo?: (context: Record<string, unknown>, message: string) => void;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}
/**
 * Fleet-side settings-revision listener. On a NOTIFY wakeup
 * or the interval poll it fetches the latest `settings_revisions` row and:
 *
 *  - holds its last-applied revision and alerts when the revision's
 *    `min_reader_version` exceeds this build's reader version (ADR-3 skew
 *    contract — never mis-apply state it cannot parse);
 *  - otherwise applies it through the exact desired-state reconcile path the
 *    workstation watcher uses (`importWorkstationSettings`), writing the
 *    runtime settings home and reloading runtime state.
 *
 * Workstation does not run this listener: local `settings.yaml` remains the
 * authority there and may mirror forward into revisions for audit/bootstrap.
 * All background work is stoppable via {@link stop}; the poll timer is unref'd
 * so it never holds the process open in tests.
 */
export declare class SettingsRevisionListener {
    private readonly deps;
    private readonly readerVersion;
    private appliedRevision;
    private unsubscribe;
    private pollTimer;
    private inFlight;
    private rerunRequested;
    private stopped;
    constructor(deps: SettingsRevisionListenerDeps);
    start(): void;
    stop(): Promise<void>;
    /** Trigger one apply pass, coalescing overlapping wakeups. */
    wake(): void;
    /**
     * Apply the latest revision if newer than the last applied one. Exposed for
     * tests that await a single pass. Returns the revision applied, the held
     * revision on skew, or null when nothing changed.
     */
    applyLatest(): Promise<{
        result: 'applied';
        revision: number;
    } | {
        result: 'held';
        revision: number;
    } | {
        result: 'unchanged';
    }>;
    /** Revision number currently applied (0 before any apply). */
    getAppliedRevision(): number;
    private holdForSkew;
    private applyRevision;
    /** Mark the worker as awaiting its first revision (red /readyz). */
    markAwaitingFirstRevision(): void;
}
