import type { BrowserProfileArtifactFile, BrowserProfileArtifactMaterializer, BrowserProfileArtifactStore } from '../domain/ports/browser-profile-artifact-store.js';
import type { BrowserProfileSnapshotRepository } from '../domain/ports/browser-profile-snapshot.js';
/**
 * Cross-worker browser profile snapshot/restore coordinator. Holds the injected
 * artifact store + snapshot repository (constructed in the adapters storage
 * factory) so the runtime browser-capability module never imports adapters. A
 * worker registers exactly one coordinator at startup via
 * {@link registerBrowserProfileSync}; the workstation single-process path simply
 * never registers one, so snapshot/restore become no-ops with zero overhead.
 */
export interface BrowserProfileSyncDeps {
    store: BrowserProfileArtifactStore & BrowserProfileArtifactMaterializer;
    repository: BrowserProfileSnapshotRepository;
    workerInstanceId?: string;
}
export interface SnapshotProfileInput {
    profileName: string;
    /** Profile directory root (`<root>/<name>`); `user-data/` lives inside it. */
    profileDir: string;
    userDataDir: string;
    appId?: string | null;
    snapshotRunId?: string | null;
    /** Lease fence of the snapshotting turn; higher == more recent ownership. */
    snapshotFencingVersion?: number;
    authMarkers?: string[];
}
export interface RestoreProfileInput {
    profileName: string;
    profileDir: string;
    userDataDir: string;
}
export declare function markBrowserProfileActivity(profileName: string): void;
/** Read-and-clear the activity flag for a profile. */
export declare function consumeBrowserProfileActivity(profileName: string): boolean;
export declare function registerBrowserProfileSync(deps: BrowserProfileSyncDeps | null): void;
export declare function isBrowserProfileSyncEnabled(): boolean;
export declare function browserProfileNeedsRestore(profileName: string, profileDir: string): Promise<boolean>;
/**
 * Walk the live `user-data/` tree into the artifact file model, dropping caches
 * and host-local junk per {@link isExcludedBrowserProfilePath}. Preserves modes
 * + relative symlinks. Returns `null` when the tree is empty (nothing to
 * snapshot).
 */
export declare function collectUserDataFiles(userDataDir: string): Promise<BrowserProfileArtifactFile[] | null>;
/**
 * Snapshot a profile after its browser was closed (bytes quiescent). Cheap
 * no-ops when: no coordinator registered, the user-data tree is empty, or the
 * content hash already matches the stored snapshot for this profile.
 *
 * Quiescence is enforced by holding the FS profile lock across the whole bundle
 * read + hash + upload. Finalize already closed the browser (releasing its
 * lock), so the lock is normally free here. But a same-worker concurrent turn
 * could relaunch Chrome between close and snapshot; if it holds the lock we SKIP
 * (status `noop`, reason `lock_held`) rather than walk a tree Chrome is actively
 * mutating — a verified hash over a torn bundle would be silently wrong. We
 * never block finalize: the acquire timeout is short and a lost race just skips.
 */
export declare function snapshotBrowserProfile(input: SnapshotProfileInput): Promise<{
    status: 'noop';
    reason: string;
} | {
    status: 'written';
    contentHash: string;
} | {
    status: 'stale';
    contentHash: string;
}>;
/**
 * Restore wrapper for the Chrome launch path. Skips fast when sync is disabled
 * or no snapshot exists.
 *
 * A genuine restore FAILURE (store unreachable, IO error) fails closed: stale
 * local state could overwrite the newer shared profile at turn finalization, so
 * we surface the error and block launch.
 *
 * An INTEGRITY error is different and fails OPEN. The bad snapshot object is the
 * same content-addressed ref on every worker, so failing closed would brick
 * launch for that profile fleet-wide with no self-healing. The store has already
 * quarantined the corrupt object; we log loudly and proceed with the local
 * profile (possibly stale; worst case the agent re-auths). The local marker is
 * intentionally NOT advanced on this path so a later good snapshot still
 * restores.
 */
export declare function restoreBrowserProfileBeforeLaunch(profileName: string, profile: {
    dir: string;
    userDataDir: string;
}): Promise<void>;
/**
 * Restore a profile before Chrome launch. No-ops when: no coordinator, no stored
 * snapshot, or the local marker already matches the stored content hash
 * (same-worker fast path). Materializes atomically (temp dir + verify + swap)
 * and quarantines on integrity mismatch.
 *
 * The caller MUST guarantee no owned Chrome is running against this user-data
 * dir (the launch path calls this only after the persisted-session adoption
 * check returns null).
 */
export declare function restoreBrowserProfile(input: RestoreProfileInput): Promise<{
    status: 'noop';
    reason: string;
} | {
    status: 'restored';
    contentHash: string;
} | {
    status: 'integrity_error';
    quarantinePath: string;
}>;
