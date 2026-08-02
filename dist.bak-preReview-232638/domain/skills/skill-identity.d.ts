import type { SkillCatalogItem } from './skills.js';
export declare function canonicalSkillReference(skill: Pick<SkillCatalogItem, 'id'>): string;
export declare function skillDisplayLabel(skill: Pick<SkillCatalogItem, 'name'>): string;
export declare function skillMaterializationKey(skill: Pick<SkillCatalogItem, 'name'>): string;
export declare function skillMaterializationKeyForName(name: string): string;
export declare function selectedSkillDisplay(skill: Pick<SkillCatalogItem, 'id' | 'name'>): string;
export interface SkillMaterializationCollision {
    key: string;
    skillIds: string[];
}
export declare function skillMaterializationCollisions(skills: Iterable<Pick<SkillCatalogItem, 'id' | 'name'>>): SkillMaterializationCollision[];
export declare function formatSkillMaterializationCollision(collision: SkillMaterializationCollision): string;
export declare function formatSkillMaterializationCollisionFragment(collision: SkillMaterializationCollision): string;
