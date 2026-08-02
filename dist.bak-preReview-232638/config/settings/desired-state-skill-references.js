import { canonicalSkillReference } from '../../domain/skills/skill-identity.js';
export function selectedSkillsFromResolvedSkillReferences(references, resolved) {
    const seen = new Set();
    const skills = [];
    for (const reference of references) {
        const skill = resolved.skills.get(reference);
        if (!skill)
            continue;
        const canonicalReference = canonicalSkillReference(skill);
        if (seen.has(canonicalReference))
            continue;
        seen.add(canonicalReference);
        skills.push(skill);
    }
    return skills;
}
export async function resolveConfiguredSkillReferences(input) {
    const uniqueReferences = [...new Set(input.references)];
    const [exactSkills, installedSkills] = await Promise.all([
        loadExactSkillReferences(input.repository, uniqueReferences),
        input.repository.listSkills({
            appId: input.appId,
            statuses: ['installed'],
        }),
    ]);
    const skills = new Map();
    const errors = new Map();
    for (const reference of uniqueReferences) {
        const exactSkill = exactSkills.get(reference);
        if (exactSkill) {
            if (isUsableSkillForSettings(input.appId, input.agentId, exactSkill)) {
                skills.set(reference, exactSkill);
            }
            else {
                errors.set(reference, `unavailable skill: ${reference}`);
            }
            continue;
        }
        if (isExactSkillReference(reference)) {
            errors.set(reference, `unavailable skill: ${reference}`);
            continue;
        }
        const skillName = reference;
        const matches = installedSkills.filter((skill) => skill.name === skillName &&
            isUsableSkillForSettings(input.appId, input.agentId, skill));
        if (matches.length === 1) {
            skills.set(reference, matches[0]);
        }
        else if (matches.length === 0) {
            errors.set(reference, `unavailable skill: ${reference}`);
        }
        else {
            errors.set(reference, ambiguousSkillNameError(skillName, matches));
        }
    }
    return { skills, errors };
}
async function loadExactSkillReferences(repository, references) {
    const exactReferences = references.filter((reference) => reference.startsWith('skill:'));
    const rows = await Promise.all(exactReferences.map(async (reference) => {
        const skill = await repository.getSkill(reference);
        return [reference, skill];
    }));
    return new Map(rows.flatMap(([reference, skill]) => skill ? [[reference, skill]] : []));
}
function isExactSkillReference(reference) {
    return reference.startsWith('skill:');
}
function ambiguousSkillNameError(skillName, matches) {
    const candidates = matches.map(canonicalSkillReference).sort();
    return `ambiguous skill name: ${skillName} matched ${matches.length} installed skills; use an exact skill id in settings, such as ${candidates.join(', ')}`;
}
function isUsableSkillForSettings(appId, agentId, skill) {
    if (skill.appId !== appId || skill.status !== 'installed')
        return false;
    return !skill.agentId || skill.agentId === agentId;
}
