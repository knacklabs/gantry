import { type S3Client } from '@aws-sdk/client-s3';
import { type MaterializedSkillArtifact, type SkillArtifactBundle, type SkillArtifactMaterializer, type SkillArtifactStore, type StoredSkillArtifact } from '../../../domain/ports/skill-artifact-store.js';
/**
 * Current-state S3 artifact store. Mirrors the local skill store layout: a
 * skill maps to the key prefix `skills/<sanitized-name>/` with one object per
 * asset. Updates replace the prefix in place (no versioning). Integrity reuses
 * the shared `hashSkillBundle` content hash; materialize verifies sha256 and
 * atomically activates, quarantining on mismatch.
 */
export declare class S3SkillArtifactStore implements SkillArtifactStore, SkillArtifactMaterializer {
    private readonly client;
    private readonly bucket;
    constructor(client: S3Client, bucket: string);
    putSkillArtifact(input: {
        appId: string;
        skillId: string;
        skillName: string;
        bundle: SkillArtifactBundle;
    }): Promise<StoredSkillArtifact>;
    getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle>;
    materializeSkillArtifact(input: {
        storageRef: string;
        expectedContentHash: string;
        targetDir: string;
        quarantineDir: string;
    }): Promise<MaterializedSkillArtifact>;
    private quarantine;
    private deletePrefix;
    private listPrefix;
    private getObjectBytes;
}
