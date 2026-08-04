import { isSkillMaterializableLocally } from '../../domain/skills/skills.js';
import { formatSkillMaterializationCollision, skillMaterializationCollisions, } from '../../domain/skills/skill-identity.js';
import { normalizeSkillAssetPath } from '../../shared/skill-artifact-helpers.js';
export async function resolveSelectedSkillProjection(input) {
    const selectedSkillIds = uniqueStrings(input.selectedSkillIds ?? []);
    if (selectedSkillIds.length === 0)
        return undefined;
    if (!input.skillRepository ||
        !input.skillArtifactStore ||
        !input.skillContext) {
        throw new Error('Selected skills require configured Gantry skill storage before runner spawn. Unselect the skill or restart Gantry with skill storage configured.');
    }
    const enabledSkills = await input.skillRepository.listEnabledSkillsForAgent({
        appId: input.skillContext.appId,
        agentId: input.skillContext.agentId,
    });
    const enabledById = new Map(enabledSkills.map((skill) => [String(skill.id), skill]));
    const selectedSkills = selectedSkillIds.map((skillId) => {
        const skill = enabledById.get(skillId);
        if (!skill) {
            throw new Error(`Selected skill "${skillId}" is not enabled for this agent. Unselect it or install and bind the skill before using it.`);
        }
        if (!isSkillMaterializableLocally(skill) || !skill.storage) {
            throw new Error(`Selected skill "${skillId}" is not installed with a materializable artifact. Unselect or reinstall the skill before using it.`);
        }
        return skill;
    });
    const collisions = skillMaterializationCollisions(selectedSkills);
    if (collisions.length > 0) {
        throw new Error(`Selected skills cannot be projected: ${formatSkillMaterializationCollision(collisions[0])}`);
    }
    const skills = [];
    let fileCount = 0;
    let contentBytes = 0;
    for (const skill of selectedSkills) {
        const item = await projectSkillArtifact({
            skill,
            artifactStore: input.skillArtifactStore,
        });
        fileCount += item.assets.length;
        contentBytes += item.assets.reduce((sum, asset) => sum + asset.content.byteLength, 0);
        skills.push(item);
    }
    return {
        selectedSkillIds,
        skills,
        skillCount: skills.length,
        fileCount,
        contentBytes,
    };
}
async function projectSkillArtifact(input) {
    if (!input.skill.storage) {
        throw new Error(`Selected skill "${input.skill.id}" is missing artifact storage.`);
    }
    const bundle = await input.artifactStore.getSkillArtifact(input.skill.storage.storageRef);
    const assets = bundle.assets
        .map((asset) => ({
        path: normalizeSkillAssetPath(asset.path),
        contentType: asset.contentType,
        content: asset.content,
    }))
        .sort((left, right) => left.path.localeCompare(right.path));
    const paths = new Set();
    for (const asset of assets) {
        if (paths.has(asset.path)) {
            throw new Error(`Selected skill "${input.skill.id}" has duplicate artifact path "${asset.path}".`);
        }
        paths.add(asset.path);
    }
    if (!assets.some((asset) => asset.path === 'SKILL.md')) {
        throw new Error(`Selected skill "${input.skill.id}" artifact must include SKILL.md.`);
    }
    return {
        id: String(input.skill.id),
        name: input.skill.name,
        contentHash: input.skill.storage.contentHash,
        actionPermissions: input.skill.actionPermissions ?? [],
        assets,
    };
}
function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}
