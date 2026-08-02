import { type S3Client } from '@aws-sdk/client-s3';
import { type BrowserProfileArtifactFile, type BrowserProfileArtifactMaterializer, type BrowserProfileArtifactStore, type MaterializedBrowserProfileArtifact, type StoredBrowserProfileArtifact } from '../../../domain/ports/browser-profile-artifact-store.js';
/**
 * Content-addressed S3 browser profile snapshot store for fleet mode. Objects
 * live under `browser-profiles/<profileName>/<contentHash>/<relpath>`.
 * Materialize lists the recorded prefix, verifies sha256 against the recorded
 * hash, and atomically activates, quarantining on mismatch.
 *
 * IAM CONTRAST vs the toolchain store: toolchain artifacts are bake-rw /
 * worker-ro (workers never mutate capability state). Browser profiles are
 * SNAPSHOTTED BY WORKERS at turn end and RESTORED BY WORKERS at launch, so the
 * worker instance role needs READ-WRITE (GetObject/PutObject/DeleteObject) on
 * the `browser-profiles/` prefix. That grant is encoded in
 * ops/terraform/modules/storage/main.tf (worker_browser_rw policy) and attached
 * to the worker role in ops/terraform/envs/fleet/main.tf. See also
 * docs/deployment/aws-terraform.md.
 */
export declare class S3BrowserProfileArtifactStore implements BrowserProfileArtifactStore, BrowserProfileArtifactMaterializer {
    private readonly client;
    private readonly bucket;
    constructor(client: S3Client, bucket: string);
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
    private fetchBrowserProfileFiles;
    private quarantine;
    private listPrefix;
    private getObject;
}
