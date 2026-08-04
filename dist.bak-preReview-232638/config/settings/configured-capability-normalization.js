import { skillActionSemanticCapability } from '../../domain/skills/skill-action-permissions.js';
import { semanticCapabilityFromToolCatalogItem, } from '../../shared/semantic-capabilities.js';
export function settingsCapabilityIdToToolRule(capabilityId) {
    const id = capabilityId.trim();
    if (id === 'browser.use')
        return 'Browser';
    if (id.includes('.') && !id.startsWith('RunCommand(')) {
        return `capability:${id}`;
    }
    return id;
}
export function toolRuleToSettingsCapability(rule, version = 'builtin') {
    if (rule === 'Browser')
        return { id: 'browser.use', version };
    if (rule.startsWith('capability:')) {
        return { id: rule.slice('capability:'.length), version };
    }
    return { id: rule, version };
}
export function skillActionDefinitionsForSkills(skills) {
    return skills.flatMap((skill) => (skill.actionPermissions ?? []).map((action) => skillActionSemanticCapability({
        skillId: String(skill.id),
        skillName: skill.name,
        action,
    })));
}
export function semanticCapabilityDefinitionsById(definitions) {
    return Object.fromEntries(definitions.map((definition) => [definition.capabilityId, definition]));
}
export function semanticCapabilityDefinitionsFromCatalogTools(tools) {
    const definitions = {};
    for (const tool of tools) {
        if (tool.status !== 'active' || !tool.selectable)
            continue;
        const definition = semanticCapabilityFromToolCatalogItem({
            name: tool.name,
            inputSchema: tool.inputSchema,
        });
        if (!definition)
            continue;
        definitions[definition.capabilityId] = definition;
    }
    return definitions;
}
export function normalizeConfiguredCapabilities(input) {
    const capabilities = [];
    const seen = new Set();
    for (const capability of input.capabilities) {
        const key = `${capability.id}\0${capability.version}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        capabilities.push(capability);
    }
    return { capabilities };
}
export async function normalizeConfiguredCapabilitiesInSettings(input) {
    let nextSettings;
    const changedAgentFolders = [];
    for (const [folder, agent] of Object.entries(input.settings.agents)) {
        const normalized = normalizeConfiguredCapabilities({
            capabilities: agent.capabilities,
        });
        if (sameCapabilities(agent.capabilities, normalized.capabilities)) {
            continue;
        }
        nextSettings ??= structuredClone(input.settings);
        nextSettings.agents[folder].capabilities = normalized.capabilities;
        changedAgentFolders.push(folder);
    }
    return {
        settings: nextSettings ?? input.settings,
        changed: Boolean(nextSettings),
        changedAgentFolders,
    };
}
function sameCapabilities(left, right) {
    if (left.length !== right.length)
        return false;
    return left.every((capability, index) => capability.id === right[index]?.id &&
        capability.version === right[index]?.version);
}
