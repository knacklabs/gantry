import { ArtifactIntegrityError } from './skill-artifact-store.js';

export { ArtifactIntegrityError };

export interface BrowserProfileArtifactFile {
  /** POSIX-relative path inside the profile `user-data/` tree (e.g. `Default/Cookies`). */
  path: string;
  kind?: 'file' | 'symlink';
  content: Uint8Array;
  mode?: number;
  linkTarget?: string;
}

export interface StoredBrowserProfileArtifact {
  storageType: 'local-filesystem' | 'object-store';
  storageRef: string;
  /** `sha256:<hex>` over the normalized file set. Recorded on the browser_profiles row. */
  contentHash: string;
  sizeBytes: number;
}

/**
 * Cross-worker browser profile snapshot writer. A live/job turn that used the
 * browser packs its `user-data/` tree (cookies, logins, Local State, storage —
 * minus caches and host-local junk) and uploads it under a per-profile
 * `browser-profiles/<profileName>/<contentHash>/` prefix. The DB row decides
 * which content-addressed ref is current, so stale fenced writers cannot
 * overwrite the bytes referenced by a newer row.
 *
 * IAM contrast vs toolchains: toolchain artifacts are bake-rw / worker-ro, but
 * browser profiles are written BY workers at turn end, so the worker role needs
 * read-write on the `browser-profiles/` prefix.
 */
export interface BrowserProfileArtifactStore {
  putBrowserProfile(input: {
    profileName: string;
    files: BrowserProfileArtifactFile[];
  }): Promise<StoredBrowserProfileArtifact>;
}

export interface MaterializedBrowserProfileArtifact {
  storageRef: string;
  contentHash: string;
  /** Absolute path of the activated `user-data/` directory on the local worker. */
  targetDir: string;
  sizeBytes: number;
}

/**
 * Worker-side fetch/verify/activate of a browser profile snapshot. The driver
 * downloads the snapshot, verifies its sha256 against the recorded content hash,
 * and atomically swaps it into the local `user-data/` directory. On mismatch it
 * does NOT activate; it moves the fetched copy to a quarantine area and throws
 * {@link ArtifactIntegrityError} for the caller to audit.
 */
export interface BrowserProfileArtifactMaterializer {
  materializeBrowserProfile(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedBrowserProfileArtifact>;
}
