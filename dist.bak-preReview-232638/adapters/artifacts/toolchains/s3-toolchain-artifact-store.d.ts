import { type S3Client } from '@aws-sdk/client-s3';
import { type MaterializedToolchainArtifact, type StoredToolchainArtifact, type ToolchainArtifactFile, type ToolchainArtifactMaterializer, type ToolchainArtifactStore } from '../../../domain/ports/toolchain-artifact-store.js';
/**
 * Current-state S3 toolchain artifact store for fleet mode. Objects live under
 * the content-addressed `toolchains/<manifestHash>/<relpath>` prefix and are
 * replaced in place on update (no versioning). Materialize lists the prefix,
 * verifies sha256 against the recorded hash, and atomically activates,
 * quarantining on mismatch. Bake role holds rw; workers hold ro (split IAM).
 */
export declare class S3ToolchainArtifactStore implements ToolchainArtifactStore, ToolchainArtifactMaterializer {
    private readonly client;
    private readonly bucket;
    constructor(client: S3Client, bucket: string);
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
    private fetchToolchainFiles;
    private quarantine;
    private deletePrefix;
    private listPrefix;
    private getObject;
}
