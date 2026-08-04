import type { SkillArtifactBundle, SkillArtifactStore, StoredSkillArtifact } from '../../../domain/ports/skill-artifact-store.js';
export declare class LocalSkillArtifactStore implements SkillArtifactStore {
    private readonly artifactRoot;
    constructor(artifactRoot: string);
    putSkillArtifact(input: {
        appId: string;
        skillId: string;
        skillName: string;
        bundle: SkillArtifactBundle;
    }): Promise<StoredSkillArtifact>;
    getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle>;
}
export declare function normalizeSkillBundle(bundle: SkillArtifactBundle): SkillArtifactBundle;
export declare function hashSkillBundle(bundle: SkillArtifactBundle): string;
