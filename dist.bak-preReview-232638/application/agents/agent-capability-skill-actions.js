import { isSkillUsableForBinding } from '../../domain/skills/skills.js';
import { skillActionSemanticCapabilitiesForSkills } from '../../domain/skills/skill-action-permissions.js';
import { canonicalizeDurableSkillActionToolRule } from '../../shared/skill-action-capability-rules.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { semanticCapabilityFromToolCatalogItem, } from '../../shared/semantic-capabilities.js';
export async function skillActionDefinitionsForAgent(input) {
    const skillBindings = await input.skillRepository.listAgentSkillBindings({
        appId: input.appId,
        agentId: input.agentId,
    });
    return skillActionDefinitionsForBindings({
        appId: input.appId,
        skillBindings,
        skillRepository: input.skillRepository,
    });
}
export async function skillActionDefinitionsForBindings(input) {
    const activeSkillIds = [
        ...new Set(input.skillBindings
            .filter((binding) => binding.status === 'active')
            .map((binding) => binding.skillId)),
    ];
    const skills = (await Promise.all(activeSkillIds.map((skillId) => input.skillRepository.getSkill(skillId)))).filter((skill) => !!skill && skill.appId === input.appId && isSkillUsableForBinding(skill));
    return skillActionSemanticCapabilitiesForSkills(skills);
}
export function canonicalToolReferenceForView(reference, options = {}) {
    const canonical = canonicalizeDurableSkillActionToolRule(reference, {
        semanticCapabilityDefinitions: options.semanticCapabilityDefinitions,
        dropGeneratedWithoutMatch: true,
    });
    return canonical ? [canonical] : [];
}
export function capabilityFromCanonicalToolReference(reference, tool, semanticCapabilityDefinitions) {
    const canonical = canonicalToolReferenceForView(reference, {
        semanticCapabilityDefinitions,
    })[0];
    if (!canonical)
        return [];
    return [
        toolReferenceToCapability(canonical, tool, semanticCapabilityDefinitions),
    ];
}
export function buildSelectedCapabilities(configuredToolEntries, semanticCapabilityDefinitions) {
    return configuredToolEntries.flatMap((entry) => capabilityFromCanonicalToolReference(entry.reference, entry.tool, semanticCapabilityDefinitions));
}
function toolReferenceToCapability(reference, tool, semanticCapabilityDefinitions) {
    if (reference === 'Browser')
        return { id: 'browser.use', version: 'builtin' };
    if (reference.startsWith('capability:')) {
        const capabilityId = parseSemanticCapabilityRule(reference);
        const semanticCapability = tool
            ? semanticCapabilityFromToolCatalogItem({
                name: tool.name,
                inputSchema: tool.inputSchema,
            })
            : undefined;
        return {
            id: reference.slice('capability:'.length),
            version: semanticCapability?.version ??
                (capabilityId
                    ? semanticCapabilityDefinitions?.[capabilityId]?.version
                    : undefined) ??
                'catalog',
        };
    }
    return { id: reference, version: 'builtin' };
}
