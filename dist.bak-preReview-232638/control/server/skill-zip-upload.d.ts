import type { SkillArtifactAsset } from '../../domain/ports/skill-artifact-store.js';
export declare const MAX_SKILL_ZIP_BYTES: number;
export type ParsedSkillZipUpload = {
    assets: SkillArtifactAsset[];
    fallbackName: string;
};
export declare function parseSkillZipUpload(input: Uint8Array): ParsedSkillZipUpload;
