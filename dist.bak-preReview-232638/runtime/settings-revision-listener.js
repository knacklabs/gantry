import { CURRENT_SETTINGS_READER_VERSION, importWorkstationSettings, settingsFromRevisionDocument, } from '../config/settings/settings-import-service.js';
import { markSettingsLoaded, markSettingsNotLoaded, } from './settings-load-state.js';
const DEFAULT_POLL_INTERVAL_MS = 30_000;
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
export class SettingsRevisionListener {
    deps;
    readerVersion;
    appliedRevision = 0;
    unsubscribe = null;
    pollTimer = null;
    inFlight = null;
    rerunRequested = false;
    stopped = false;
    constructor(deps) {
        this.deps = deps;
        this.readerVersion = deps.readerVersion ?? CURRENT_SETTINGS_READER_VERSION;
    }
    start() {
        if (this.unsubscribe || this.stopped)
            return;
        this.unsubscribe = this.deps.wakeupSource.subscribe(() => this.wake());
        const setIntervalFn = this.deps.setIntervalFn ?? setInterval;
        const timer = setIntervalFn(() => this.wake(), this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        timer.unref?.();
        this.pollTimer = timer;
        this.wake();
    }
    async stop() {
        this.stopped = true;
        if (this.pollTimer) {
            (this.deps.clearIntervalFn ?? clearInterval)(this.pollTimer);
            this.pollTimer = null;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        await this.inFlight?.catch(() => { });
        await this.deps.wakeupSource.close();
    }
    /** Trigger one apply pass, coalescing overlapping wakeups. */
    wake() {
        if (this.stopped)
            return;
        if (this.inFlight) {
            this.rerunRequested = true;
            return;
        }
        this.inFlight = this.applyLatest()
            .then(() => undefined)
            .catch((err) => this.deps.logWarn?.({ err }, 'Settings revision apply failed'))
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
    async applyLatest() {
        if (this.stopped)
            return { result: 'unchanged' };
        const latest = await this.deps.settingsRevisions.getLatestSettingsRevision(this.deps.appId);
        if (!latest)
            return { result: 'unchanged' };
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
    getAppliedRevision() {
        return this.appliedRevision;
    }
    holdForSkew(revision) {
        this.deps.onSkewAlert?.({
            appId: revision.appId,
            revision: revision.revision,
            minReaderVersion: revision.minReaderVersion,
            readerVersion: this.readerVersion,
        });
        this.deps.logWarn?.({
            appId: revision.appId,
            revision: revision.revision,
            minReaderVersion: revision.minReaderVersion,
            readerVersion: this.readerVersion,
            appliedRevision: this.appliedRevision,
        }, 'Settings revision requires a newer reader version; holding last-applied ' +
            'revision until this worker is upgraded');
    }
    async applyRevision(revision) {
        const settings = settingsFromRevisionDocument(revision.settingsDocument);
        await importWorkstationSettings({
            runtimeHome: this.deps.runtimeHome,
            ops: this.deps.ops,
            repositories: this.deps.repositories,
            appId: this.deps.appId,
            reloadRuntimeState: this.deps.reloadRuntimeState,
        }, settings);
        const previousRevision = this.appliedRevision;
        this.appliedRevision = revision.revision;
        if (previousRevision === 0) {
            markSettingsLoaded();
            try {
                await this.deps.onFirstRevisionApplied?.(settings);
            }
            catch (err) {
                this.deps.logWarn?.({ err, revision: revision.revision }, 'First-revision start hook failed; held services may need a restart');
            }
        }
        this.deps.logInfo?.({ appId: revision.appId, revision: revision.revision }, 'Applied settings revision');
    }
    /** Mark the worker as awaiting its first revision (red /readyz). */
    markAwaitingFirstRevision() {
        if (this.appliedRevision === 0)
            markSettingsNotLoaded();
    }
}
