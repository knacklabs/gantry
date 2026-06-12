import type { AppId } from '../domain/app/app.js';
import type {
  SettingsRevision,
  SettingsRevisionRepository,
} from '../domain/ports/fleet-capability-state.js';
import type {
  SettingsDesiredStateOps,
  SettingsDesiredStateRepositories,
} from '../config/settings/desired-state-service.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  importWorkstationSettings,
  settingsFromRevisionDocument,
} from '../config/settings/settings-import-service.js';
import type { SettingsRevisionWakeupSource } from '../config/settings/settings-revision-notify.js';
import {
  markSettingsLoaded,
  markSettingsNotLoaded,
} from './settings-load-state.js';

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
  onFirstRevisionApplied?: () => Promise<void> | void;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
  logInfo?: (context: Record<string, unknown>, message: string) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Worker-side settings-revision listener (fleet mode only). On a NOTIFY wakeup
 * or the interval poll it fetches the latest `settings_revisions` row and:
 *
 *  - holds its last-applied revision and alerts when the revision's
 *    `min_reader_version` exceeds this build's reader version (ADR-3 skew
 *    contract — never mis-apply state it cannot parse);
 *  - otherwise applies it through the exact desired-state reconcile path the
 *    workstation watcher uses (`importWorkstationSettings`), writing the
 *    runtime settings home and reloading runtime state.
 *
 * All background work is stoppable via {@link stop}; the poll timer is unref'd
 * so it never holds the process open in tests.
 */
export class SettingsRevisionListener {
  private readonly readerVersion: number;
  private appliedRevision = 0;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private stopped = false;

  constructor(private readonly deps: SettingsRevisionListenerDeps) {
    this.readerVersion = deps.readerVersion ?? CURRENT_SETTINGS_READER_VERSION;
  }

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.deps.wakeupSource.subscribe(() => this.wake());
    const setIntervalFn = this.deps.setIntervalFn ?? setInterval;
    const timer = setIntervalFn(
      () => this.wake(),
      this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    (
      timer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
    this.pollTimer = timer;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.inFlight?.catch(() => {});
    await this.deps.wakeupSource.close();
  }

  /** Trigger one apply pass, coalescing overlapping wakeups. */
  wake(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = this.applyLatest()
      .then(() => undefined)
      .catch((err) =>
        this.deps.logWarn?.({ err }, 'Settings revision apply failed'),
      )
      .finally(() => {
        this.inFlight = null;
        if (this.rerunRequested && !this.stopped) {
          this.rerunRequested = false;
          this.wake();
        }
      });
  }

  /**
   * Apply the latest revision if newer than the last applied one. Exposed for
   * tests that await a single pass. Returns the revision applied, the held
   * revision on skew, or null when nothing changed.
   */
  async applyLatest(): Promise<
    | { result: 'applied'; revision: number }
    | { result: 'held'; revision: number }
    | { result: 'unchanged' }
  > {
    if (this.stopped) return { result: 'unchanged' };
    const latest = await this.deps.settingsRevisions.getLatestSettingsRevision(
      this.deps.appId,
    );
    if (!latest) return { result: 'unchanged' };
    if (latest.revision <= this.appliedRevision) {
      return { result: 'unchanged' };
    }
    if (latest.minReaderVersion > this.readerVersion) {
      this.holdForSkew(latest);
      return { result: 'held', revision: latest.revision };
    }
    await this.applyRevision(latest);
    return { result: 'applied', revision: latest.revision };
  }

  /** Revision number currently applied (0 before any apply). */
  getAppliedRevision(): number {
    return this.appliedRevision;
  }

  private holdForSkew(revision: SettingsRevision): void {
    this.deps.onSkewAlert?.({
      appId: revision.appId,
      revision: revision.revision,
      minReaderVersion: revision.minReaderVersion,
      readerVersion: this.readerVersion,
    });
    this.deps.logWarn?.(
      {
        appId: revision.appId,
        revision: revision.revision,
        minReaderVersion: revision.minReaderVersion,
        readerVersion: this.readerVersion,
        appliedRevision: this.appliedRevision,
      },
      'Settings revision requires a newer reader version; holding last-applied ' +
        'revision until this worker is upgraded',
    );
  }

  private async applyRevision(revision: SettingsRevision): Promise<void> {
    const settings = settingsFromRevisionDocument(revision.settingsDocument);
    await importWorkstationSettings(
      {
        runtimeHome: this.deps.runtimeHome,
        ops: this.deps.ops,
        repositories: this.deps.repositories,
        appId: this.deps.appId,
        reloadRuntimeState: this.deps.reloadRuntimeState,
      },
      settings,
    );
    const previousRevision = this.appliedRevision;
    this.appliedRevision = revision.revision;
    if (previousRevision === 0) {
      markSettingsLoaded();
      try {
        await this.deps.onFirstRevisionApplied?.();
      } catch (err) {
        this.deps.logWarn?.(
          { err, revision: revision.revision },
          'First-revision start hook failed; held services may need a restart',
        );
      }
    }
    this.deps.logInfo?.(
      { appId: revision.appId, revision: revision.revision },
      'Applied fleet settings revision',
    );
  }

  /** Mark the worker as awaiting its first revision (red /readyz). */
  markAwaitingFirstRevision(): void {
    if (this.appliedRevision === 0) markSettingsNotLoaded();
  }
}
