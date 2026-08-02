import { ApplicationError } from '../common/application-error.js';
import { resolveAgentToolRuntimePolicy, resolveAgentToolRuntimeRules, } from '../agents/agent-tool-runtime-rules.js';
export function agentIdForJobWorkspaceKey(workspaceKey) {
    const trimmed = workspaceKey.trim();
    return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}
export async function resolveJobToolPolicy(input) {
    const inheritedTools = input.appId && input.agentId
        ? await resolveAgentToolBindingPolicy({
            repository: input.toolRepository,
            appId: input.appId,
            agentId: input.agentId,
            skillRepository: input.skillRepository,
        })
        : {
            rules: [],
            runtimeAccess: [],
        };
    return {
        inheritedTools: inheritedTools.rules,
        effectiveAllowedTools: mergeUnique(inheritedTools.rules),
        runtimeAccess: inheritedTools.runtimeAccess,
    };
}
export async function resolveAgentToolBindings(input) {
    if (!input.repository)
        return [];
    return resolveAgentToolRuntimeRules({
        repository: input.repository,
        appId: input.appId,
        agentId: input.agentId,
        errorSubject: 'Inherited agent tool',
        skillRepository: input.skillRepository,
        makeError: (message) => new ApplicationError('FORBIDDEN', message),
    });
}
export async function resolveAgentToolBindingPolicy(input) {
    if (!input.repository) {
        return {
            rules: [],
            runtimeAccess: [],
        };
    }
    const policy = await resolveAgentToolRuntimePolicy({
        repository: input.repository,
        appId: input.appId,
        agentId: input.agentId,
        errorSubject: 'Inherited agent tool',
        skillRepository: input.skillRepository,
        makeError: (message) => new ApplicationError('FORBIDDEN', message),
    });
    return {
        rules: policy.rules,
        runtimeAccess: policy.runtimeAccess,
    };
}
function mergeUnique(base) {
    const out = new Set();
    for (const item of base) {
        const value = item.trim();
        if (value)
            out.add(value);
    }
    return [...out];
}
