import { resolveAgentToolRuntimePolicy, resolveAgentToolRuntimeRules, } from '../application/agents/agent-tool-runtime-rules.js';
export async function resolveConfiguredAllowedTools(input) {
    if (!input.repository)
        return undefined;
    return resolveAgentToolRuntimeRules({
        repository: input.repository,
        appId: input.appId,
        agentId: input.agentId,
        errorSubject: 'Configured agent tool',
        skillRepository: input.skillRepository,
    });
}
export async function resolveConfiguredToolPolicy(input) {
    if (!input.repository) {
        return {
            toolPolicyRules: undefined,
            runtimeAccess: [],
            semanticCapabilities: [],
        };
    }
    const policy = await resolveAgentToolRuntimePolicy({
        repository: input.repository,
        appId: input.appId,
        agentId: input.agentId,
        errorSubject: 'Configured agent tool',
        skillRepository: input.skillRepository,
    });
    return {
        toolPolicyRules: policy.rules,
        runtimeAccess: policy.runtimeAccess,
        semanticCapabilities: policy.semanticCapabilities,
    };
}
