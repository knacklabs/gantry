import { materializedSkillDirectoryNameFor } from './skills.js';
export function canonicalSkillReference(skill) {
    return String(skill.id);
}
export function skillDisplayLabel(skill) {
    return skill.name;
}
export function skillMaterializationKey(skill) {
    return skillMaterializationKeyForName(skill.name);
}
export function skillMaterializationKeyForName(name) {
    return materializedSkillDirectoryNameFor(name).toLowerCase();
}
export function selectedSkillDisplay(skill) {
    const reference = canonicalSkillReference(skill);
    const label = skillDisplayLabel(skill);
    return label === reference ? reference : `${label} (${reference})`;
}
export function skillMaterializationCollisions(skills) {
    const byKey = new Map();
    for (const skill of skills) {
        const key = skillMaterializationKey(skill);
        const skillIds = byKey.get(key) ?? new Set();
        skillIds.add(canonicalSkillReference(skill));
        byKey.set(key, skillIds);
    }
    return [...byKey.entries()]
        .flatMap(([key, skillIds]) => skillIds.size > 1
        ? [
            {
                key,
                skillIds: [...skillIds].sort(),
            },
        ]
        : [])
        .sort((left, right) => left.key.localeCompare(right.key));
}
export function formatSkillMaterializationCollision(collision) {
    const fragment = formatSkillMaterializationCollisionFragment(collision);
    return `${fragment.slice(0, 1).toUpperCase()}${fragment.slice(1)}.`;
}
export function formatSkillMaterializationCollisionFragment(collision) {
    return `selected skills that materialize to the same runtime directory "${collision.key}": ${collision.skillIds.join(', ')}. Keep only one exact skill id`;
}
