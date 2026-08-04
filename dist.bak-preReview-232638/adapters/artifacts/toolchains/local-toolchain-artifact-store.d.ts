import { type MaterializedToolchainArtifact, type StoredToolchainArtifact, type ToolchainArtifactFile, type ToolchainArtifactMaterializer, type ToolchainArtifactStore } from '../../../domain/ports/toolchain-artifact-store.js';
/**
 * Filesystem-backed toolchain artifact store. Mirrors the local skill store:
 * replace-on-update under the content-addressed `toolchains/<hash>/` prefix,
 * sha256-verified atomic materialize with quarantine on mismatch. Used for the
 * disposable-Postgres integration rehearsal and as the injected fake-free store
 * in tests; fleet production uses the S3 variant.
 */
export declare class LocalToolchainArtifactStore implements ToolchainArtifactStore, ToolchainArtifactMaterializer {
    private readonly artifactRoot;
    constructor(artifactRoot: string);
    putToolchainArtifact(input: {
        appId: string;
        manifestHash: string;
        files: ToolchainArtifactFile[];
    }): Promise<StoredToolchainArtifact>;
    materializeToolchainArtifact(input: {
        storageRef: string;
        expectedContentHash: string;
        targetDir: string;
        quarantineDir: string;
    }): Promise<MaterializedToolchainArtifact>;
    private resolveStoragePath;
}
