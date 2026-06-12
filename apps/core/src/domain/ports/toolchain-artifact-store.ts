import { ArtifactIntegrityError } from './skill-artifact-store.js';

export { ArtifactIntegrityError };

export interface ToolchainArtifactFile {
  /** POSIX-relative path inside the toolchain (e.g. `node_modules/left-pad/index.js`). */
  path: string;
  kind?: 'file' | 'symlink';
  content: Uint8Array;
  mode?: number;
  linkTarget?: string;
}

export interface StoredToolchainArtifact {
  storageType: 'local-filesystem' | 'object-store';
  storageRef: string;
  /** `sha256:<hex>` over the normalized file set. Bake records this on the row. */
  contentHash: string;
  sizeBytes: number;
}

/**
 * Current-state toolchain artifact writer used by the bake job. A bake packs
 * the produced `node_modules` + lockfile + `package.json` and uploads it under
 * a content-addressed `toolchains/<manifestHash>/` prefix, replacing any prior
 * artifact in place (no versioning, per ADR capability-artifacts).
 */
export interface ToolchainArtifactStore {
  putToolchainArtifact(input: {
    appId: string;
    manifestHash: string;
    files: ToolchainArtifactFile[];
  }): Promise<StoredToolchainArtifact>;
}

export interface MaterializedToolchainArtifact {
  storageRef: string;
  contentHash: string;
  /** Absolute path of the activated toolchain directory on the local worker. */
  targetDir: string;
  sizeBytes: number;
}

/**
 * Worker-side fetch/verify/activate of a current-state toolchain artifact. The
 * driver downloads the artifact, verifies its sha256 against the recorded
 * content hash, and atomically swaps it into place. On mismatch it does NOT
 * activate; it moves the fetched copy to a quarantine area and throws
 * {@link ArtifactIntegrityError} for the caller to audit.
 */
export interface ToolchainArtifactMaterializer {
  materializeToolchainArtifact(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedToolchainArtifact>;
}
