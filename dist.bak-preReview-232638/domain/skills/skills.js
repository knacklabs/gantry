import { sanitizeSkillDirectoryName, } from './skill-action-permissions.js';
export const RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAMES = [
    'gantry-admin',
    'gantry-browser',
];
const RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAME_SET = new Set(RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAMES.map((name) => name.toLowerCase()));
export function isSkillUsableForBinding(skill) {
    return skill.status === 'installed';
}
export function isSkillMaterializableLocally(skill) {
    return isSkillUsableForBinding(skill) && !!skill.storage;
}
export function materializedSkillDirectoryNameFor(skillName) {
    return sanitizeSkillDirectoryName(skillName);
}
export function reservedMaterializedSkillDirectoryNameFor(skillName) {
    const directoryName = materializedSkillDirectoryNameFor(skillName);
    const normalized = directoryName.toLowerCase();
    return RESERVED_MATERIALIZED_SKILL_DIRECTORY_NAME_SET.has(normalized)
        ? normalized
        : null;
}
