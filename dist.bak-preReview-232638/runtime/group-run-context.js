import { resolveConfiguredToolPolicy, } from './configured-agent-tools.js';
import { authorizedMcpServerIdsForAgent } from '../application/mcp/mcp-authorized-servers.js';
import { skillActionDefinitionsForAgent } from '../application/agents/agent-capability-skill-actions.js';
import { resolveAgentPromptCapabilityCatalog } from '../application/agents/agent-prompt-capability-catalog.js';
import { selectedSkillDisplay } from '../domain/skills/skill-identity.js';
import { semanticCapabilityFromToolCatalogItem, } from '../shared/semantic-capabilities.js';
export function memoryScopeForConversationKind(conversationKind) {
    return conversationKind === 'dm' ? 'user' : 'group';
}
export async function resolveTurnToolPolicy(deps, turnContext) {
    if (!turnContext) {
        return {
            toolPolicyRules: undefined,
            runtimeAccess: [],
            semanticCapabilities: [],
        };
    }
    return resolveConfiguredToolPolicy({
        repository: deps.getToolRepository?.(),
        skillRepository: deps.getSkillRepository?.(),
        appId: turnContext.appId,
        agentId: turnContext.agentId,
    });
}
export async function resolveTurnSelectedSkillContext(deps, turnContext) {
    const repository = deps.getSkillRepository?.();
    if (!turnContext || !repository)
        return {};
    const bindings = await repository.listAgentSkillBindings({
        appId: turnContext.appId,
        agentId: turnContext.agentId,
    });
    const activeBindings = bindings
        .filter((binding) => binding.status === 'active')
        .sort((left, right) => String(left.skillId).localeCompare(String(right.skillId)));
    const skillRows = await Promise.all(activeBindings.map((binding) => repository.getSkill(binding.skillId)));
    return {
        ids: activeBindings.map((binding) => String(binding.skillId)),
        displays: activeBindings.map((binding, index) => {
            const skill = skillRows[index];
            return skill ? selectedSkillDisplay(skill) : String(binding.skillId);
        }),
    };
}
export async function resolveTurnSelectedMcpServerIds(deps, turnContext) {
    const mcpServers = deps.getMcpServerRepository?.();
    if (!turnContext || !mcpServers)
        return undefined;
    return authorizedMcpServerIdsForAgent({
        mcpServers,
        appId: turnContext.appId,
        agentId: turnContext.agentId,
    });
}
export function resolveTurnPromptCapabilityCatalog(deps, scope, readySemanticCapabilities) {
    return resolveAgentPromptCapabilityCatalog({
        ...scope,
        readySemanticCapabilities,
        skillRepository: deps.getSkillRepository?.(),
        mcpServerRepository: deps.getMcpServerRepository?.(),
    });
}
export async function resolveTurnSemanticCapabilities(deps, turnContext) {
    if (!turnContext)
        return [];
    const byId = new Map();
    const toolRepository = deps.getToolRepository?.();
    if (toolRepository) {
        const tools = await toolRepository.listTools({
            appId: turnContext.appId,
            statuses: ['active'],
        });
        for (const tool of tools) {
            const capability = semanticCapabilityFromToolCatalogItem(tool);
            if (capability)
                byId.set(capability.capabilityId, capability);
        }
    }
    const skillRepository = deps.getSkillRepository?.();
    if (skillRepository) {
        const definitions = await skillActionDefinitionsForAgent({
            appId: turnContext.appId,
            agentId: turnContext.agentId,
            skillRepository,
        });
        for (const definition of Object.values(definitions)) {
            byId.set(definition.capabilityId, definition);
        }
    }
    return [...byId.values()].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}
