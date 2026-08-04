import { isSkillMaterializableLocally, isSkillUsableForBinding, materializedSkillDirectoryNameFor, reservedMaterializedSkillDirectoryNameFor, } from '../../domain/skills/skills.js';
import { skillMaterializationKey, skillMaterializationKeyForName, } from '../../domain/skills/skill-identity.js';
import { parseSkillActionPermissionsFromAssets } from '../../domain/skills/skill-action-permissions.js';
import { assertValidCapabilitySecretName, normalizeCapabilitySecretName, } from '../../domain/capability-secrets/capability-secrets.js';
import { reservedSdkNativeSkillNameFor } from '../../shared/sdk-native-skill-names.js';
import { nowIso } from '../../shared/time/datetime.js';
export class SkillService {
    skills;
    artifacts;
    constructor(skills, artifacts) {
        this.skills = skills;
        this.artifacts = artifacts;
    }
    async installSkill(input) {
        const now = input.now ?? nowIso();
        const metadata = resolveSkillMetadata({
            assets: input.assets,
            name: input.name,
            description: input.description,
            fallbackName: input.fallbackName,
            requiredEnvVars: input.requiredEnvVars,
        });
        assertSkillMetadataCanBeMaterialized({
            catalogName: metadata.name,
            declaredName: metadata.declaredName,
        });
        const existing = await this.findExistingSkillByMaterializationKey({
            appId: input.appId,
            name: metadata.name,
        });
        const skillId = existing?.id ?? `skill:${globalThis.crypto.randomUUID()}`;
        const stored = await this.artifacts.putSkillArtifact({
            appId: input.appId,
            skillId,
            skillName: metadata.name,
            bundle: { assets: input.assets },
        });
        const skill = {
            id: skillId,
            appId: input.appId,
            agentId: undefined,
            name: metadata.name,
            description: metadata.description,
            source: existing?.source ??
                (input.agentId ? 'agent_created' : 'admin_uploaded'),
            status: 'installed',
            promptRefs: [],
            toolIds: [],
            workflowRefs: [],
            requiredEnvVars: metadata.requiredEnvVars,
            actionPermissions: metadata.actionPermissions,
            storage: stored,
            createdBy: input.createdBy,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await this.skills.saveSkill(skill);
        await this.disableInstalledMaterializationDuplicates({
            appId: input.appId,
            keepSkillId: skill.id,
            name: skill.name,
            updatedAt: now,
        });
        return skill;
    }
    listSkills(input) {
        return this.skills.listSkills({
            appId: input.appId,
            agentId: input.agentId,
            statuses: input.statuses ?? ['installed'],
        });
    }
    async bindSkillToAgent(input) {
        const skill = await this.requireSkill(input.appId, input.skillId);
        if (!isSkillUsableForBinding(skill)) {
            throw new Error(`Skill must be installed before binding: ${skill.id}`);
        }
        const now = input.now ?? nowIso();
        await this.disableActiveMaterializationCollisions({
            appId: input.appId,
            agentId: input.agentId,
            skill,
            updatedAt: now,
        });
        const binding = {
            id: `agent-skill-binding:${input.agentId}:${input.skillId}`,
            appId: input.appId,
            agentId: input.agentId,
            skillId: input.skillId,
            status: 'active',
            createdAt: now,
            updatedAt: now,
        };
        await this.skills.saveAgentSkillBinding(binding);
        return binding;
    }
    async disableActiveMaterializationCollisions(input) {
        const targetKey = skillMaterializationKey(input.skill);
        const bindings = await this.skills.listAgentSkillBindings({
            appId: input.appId,
            agentId: input.agentId,
        });
        await Promise.all(bindings
            .filter((binding) => binding.status === 'active' && binding.skillId !== input.skill.id)
            .map(async (binding) => {
            const existing = await this.skills.getSkill(binding.skillId);
            if (!existing || skillMaterializationKey(existing) !== targetKey) {
                return;
            }
            await this.skills.disableAgentSkillBinding({
                appId: input.appId,
                agentId: input.agentId,
                skillId: binding.skillId,
                updatedAt: input.updatedAt,
            });
        }));
    }
    unbindSkillFromAgent(input) {
        return this.skills.disableAgentSkillBinding({
            appId: input.appId,
            agentId: input.agentId,
            skillId: input.skillId,
            updatedAt: input.now ?? nowIso(),
        });
    }
    async rollbackInstalledSkillBinding(input) {
        const now = input.now ?? nowIso();
        await this.skills.disableAgentSkillBinding({
            appId: input.appId,
            agentId: input.agentId,
            skillId: input.skillId,
            updatedAt: now,
        });
    }
    async resolveLocalSkillsForAgent(input) {
        const skills = await this.skills.listEnabledSkillsForAgent(input);
        return skills.filter(isSkillMaterializableLocally);
    }
    // Install-time collision validation (trace defect 3): a skill whose
    // materialized directory collides with a DIFFERENT skill currently enabled
    // for the agent would pass install but fail the next spawn's projection.
    // Returns an honest failure reason, or null when the install is safe (a
    // same catalog id, or the exact package name when no id exists yet, is an
    // in-place replacement rather than a same-directory collision).
    async installMaterializationCollisionForAgent(input) {
        const key = skillMaterializationKeyForName(input.name);
        const replacementSkillId = input.skillId ??
            (await this.skills.listSkills({
                appId: input.appId,
                statuses: ['installed'],
            })).find((skill) => skill.name === input.name)?.id;
        const enabledSkills = await this.skills.listEnabledSkillsForAgent({
            appId: input.appId,
            agentId: input.agentId,
        });
        const colliding = enabledSkills.find((skill) => skillMaterializationKey(skill) === key &&
            skill.id !== replacementSkillId);
        if (!colliding)
            return null;
        return `Skill "${input.name}" cannot be installed: it materializes to the same runtime directory "${key}" as the currently selected skill ${colliding.name} (${colliding.id}). Rename the skill or unselect the colliding skill first.`;
    }
    async requireSkill(appId, skillId) {
        const skill = await this.skills.getSkill(skillId);
        if (!skill || skill.appId !== appId) {
            throw new Error(`Skill not found: ${skillId}`);
        }
        return skill;
    }
    async findExistingSkillByMaterializationKey(input) {
        const existing = await this.skills.listSkills({
            appId: input.appId,
            statuses: ['installed'],
        });
        const targetKey = skillMaterializationKeyForName(input.name);
        return (existing.find((skill) => skillMaterializationKey(skill) === targetKey) ??
            null);
    }
    async disableInstalledMaterializationDuplicates(input) {
        const skills = await this.skills.listSkills({
            appId: input.appId,
            statuses: ['installed'],
        });
        const targetKey = skillMaterializationKeyForName(input.name);
        await Promise.all(skills
            .filter((skill) => skill.id !== input.keepSkillId &&
            skillMaterializationKey(skill) === targetKey)
            .map((skill) => this.skills.saveSkill({
            ...skill,
            status: 'disabled',
            updatedAt: input.updatedAt,
        })));
    }
}
function resolveSkillMetadata(input) {
    const skillMd = input.assets.find((asset) => asset.path === 'SKILL.md');
    const frontmatter = skillMd
        ? parseSkillFrontmatter(Buffer.from(skillMd.content).toString('utf-8'))
        : {};
    const declaredName = cleanMetadataText(frontmatter.name);
    const name = cleanMetadataText(input.name) ||
        declaredName ||
        cleanMetadataText(input.fallbackName) ||
        'uploaded-skill';
    const description = cleanMetadataText(input.description) ||
        cleanMetadataText(frontmatter.description);
    const actionPermissions = parseSkillActionPermissionsFromAssets({
        assets: input.assets,
        skillName: name,
    });
    return {
        name,
        description,
        declaredName,
        requiredEnvVars: normalizeRequiredEnvVars([
            ...(input.requiredEnvVars ?? []),
            ...frontmatterEnvVars(frontmatter),
            ...actionPermissions.flatMap((action) => action.requiredEnvVars),
        ]),
        actionPermissions,
    };
}
function frontmatterEnvVars(frontmatter) {
    return [
        frontmatter.required_env,
        frontmatter.required_env_vars,
        frontmatter.env,
        frontmatter.env_vars,
    ]
        .filter((value) => Boolean(value))
        .flatMap((value) => value.split(/[,\s]+/));
}
function normalizeRequiredEnvVars(values) {
    const normalized = values
        .map(normalizeCapabilitySecretName)
        .filter((value) => value.length > 0);
    for (const name of normalized)
        assertValidCapabilitySecretName(name);
    return [...new Set(normalized)];
}
function assertSkillMetadataCanBeMaterialized(input) {
    assertSkillNameDoesNotCollideWithReservedMaterialization(input.catalogName);
    if (!input.declaredName)
        return;
    assertSkillNameDoesNotCollideWithReservedMaterialization(input.declaredName);
    const catalogDirectory = materializedSkillDirectoryNameFor(input.catalogName).toLowerCase();
    const declaredDirectory = materializedSkillDirectoryNameFor(input.declaredName).toLowerCase();
    if (catalogDirectory !== declaredDirectory) {
        throw new Error(`Skill "${input.catalogName}" declares SDK skill name "${input.declaredName}" but materializes as "${materializedSkillDirectoryNameFor(input.catalogName)}". Keep the SKILL.md name aligned with the Gantry skill name.`);
    }
}
function assertSkillNameDoesNotCollideWithReservedMaterialization(name) {
    const reservedName = reservedMaterializedSkillDirectoryNameFor(name);
    if (reservedName) {
        throw new Error(`Skill name "${name}" materializes to reserved Gantry skill directory "${reservedName}". Choose a different skill name.`);
    }
    const reservedNativeName = reservedSdkNativeSkillNameFor(name);
    if (reservedNativeName) {
        throw new Error(`Skill name "${name}" materializes to reserved SDK-native skill name "${reservedNativeName}". Choose a different skill name.`);
    }
}
function parseSkillFrontmatter(content) {
    if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
        return {};
    }
    const normalized = content.replace(/\r\n/g, '\n');
    const end = normalized.indexOf('\n---', 4);
    if (end < 0)
        return {};
    const lines = normalized.slice(4, end).split('\n');
    const metadata = {};
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (!match)
            continue;
        const key = match[1];
        const rawValue = match[2];
        if (rawValue === '|') {
            const block = [];
            while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
                i += 1;
                block.push(lines[i].replace(/^\s{2}/, ''));
            }
            metadata[key] = block.join('\n').trim();
            continue;
        }
        metadata[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
    }
    return metadata;
}
function cleanMetadataText(value) {
    const trimmed = value?.trim();
    return trimmed || undefined;
}
