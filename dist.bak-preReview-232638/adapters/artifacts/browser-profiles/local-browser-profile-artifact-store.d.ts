import { type BrowserProfileArtifactFile, type BrowserProfileArtifactMaterializer, type BrowserProfileArtifactStore, type MaterializedBrowserProfileArtifact, type StoredBrowserProfileArtifact } from '../../../domain/ports/browser-profile-artifact-store.js';
/**
 * Filesystem-backed browser profile snapshot store. Mirrors the local toolchain
 * store: content-addressed `browser-profiles/<name>/<hash>/` prefixes with
 * sha256-verified atomic materialize and quarantine on mismatch. Used for the
 * workstation single-process deployment and as the injected store in tests;
 * fleet production uses the S3 variant.
 */
export declare class LocalBrowserProfileArtifactStore implements BrowserProfileArtifactStore, BrowserProfileArtifactMaterializer {
    private readonly artifactRoot;
    constructor(artifactRoot: string);
    putBrowserProfile(input: {
        profileName: string;
        files: BrowserProfileArtifactFile[];
    }): Promise<StoredBrowserProfileArtifact>;
    materializeBrowserProfile(input: {
        storageRef: string;
        expectedContentHash: string;
        targetDir: string;
        quarantineDir: string;
    }): Promise<MaterializedBrowserProfileArtifact>;
    private resolveStoragePath;
}
