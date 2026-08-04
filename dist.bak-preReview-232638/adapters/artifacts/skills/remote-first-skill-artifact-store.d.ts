import type { SkillArtifactBundle, SkillArtifactStore, StoredSkillArtifact } from '../../../domain/ports/skill-artifact-store.js';
/**
 * Remote-authoritative skill artifact store with a local cache.
 *
 * Fleet deployments can replace their local runtime home on every task start,
 * but selected skill metadata is durable. The object store must therefore be
 * the source of truth once configured; local disk is only a warm cache for
 * faster access and legacy recovery while an old local artifact is being synced.
 */
export declare class RemoteFirstSkillArtifactStore implements SkillArtifactStore {
    private readonly authority;
    private readonly cache;
    constructor(authority: SkillArtifactStore, cache: SkillArtifactStore);
    putSkillArtifact(input: {
        appId: string;
        skillId: string;
        skillName: string;
        bundle: SkillArtifactBundle;
    }): Promise<StoredSkillArtifact>;
    getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle>;
    private tryWarmCache;
}
