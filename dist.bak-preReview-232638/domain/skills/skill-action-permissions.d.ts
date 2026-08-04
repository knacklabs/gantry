import type { SemanticCapabilityDefinition, SemanticCapabilityRisk } from '../../shared/semantic-capabilities.js';
export declare const SKILL_ACTION_MANIFEST_FILE = "gantry.skill.json";
export interface SkillActionPermission {
    id: string;
    capabilityId: string;
    displayName: string;
    risk: SemanticCapabilityRisk;
    can: string;
    cannot: string;
    requiredEnvVars: string[];
    commandTemplates: string[];
    networkHosts: string[];
}
export interface SkillActionSourceMetadata {
    kind: 'skill_action';
    skillId: string;
    skillName: string;
    actionId: string;
}
export interface SkillActionCapabilitySourceSkill {
    id: string;
    name: string;
    actionPermissions?: SkillActionPermission[];
}
export declare function sanitizeSkillDirectoryName(value: string): string;
export declare function parseSkillActionPermissionsFromAssets(input: {
    assets: Array<{
        path: string;
        content: Uint8Array;
    }>;
    skillName: string;
}): SkillActionPermission[];
export declare function skillActionSemanticCapability(input: {
    skillId: string;
    skillName: string;
    action: SkillActionPermission;
}): SemanticCapabilityDefinition;
export declare function skillActionSource(capability: SemanticCapabilityDefinition): SkillActionSourceMetadata | undefined;
export declare function skillActionSemanticCapabilitiesForSkills(skills: Iterable<SkillActionCapabilitySourceSkill>): Record<string, SemanticCapabilityDefinition>;
