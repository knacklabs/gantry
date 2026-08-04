import type { SkillArtifactStore } from '../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillActionPermission } from '../../domain/skills/skill-action-permissions.js';
export interface SelectedSkillProjectionAsset {
    path: string;
    contentType?: string;
    content: Uint8Array;
}
export interface SelectedSkillProjectionItem {
    id: string;
    name: string;
    contentHash?: string;
    actionPermissions: SkillActionPermission[];
    assets: SelectedSkillProjectionAsset[];
}
export interface SelectedSkillProjection {
    selectedSkillIds: string[];
    skills: SelectedSkillProjectionItem[];
    skillCount: number;
    fileCount: number;
    contentBytes: number;
}
export declare function resolveSelectedSkillProjection(input: {
    selectedSkillIds?: readonly string[];
    skillRepository?: SkillCatalogRepository;
    skillArtifactStore?: SkillArtifactStore;
    skillContext?: {
        appId: string;
        agentId: string;
    };
}): Promise<SelectedSkillProjection | undefined>;
