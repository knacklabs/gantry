const policies = new Map();
export function registerAsyncCommandSandboxPolicy(input) {
    policies.set(policyKey(input.sourceAgentFolder, input.runHandle), input.policy);
}
export function readAsyncCommandSandboxPolicy(input) {
    if (!input.runHandle)
        return undefined;
    return policies.get(policyKey(input.sourceAgentFolder, input.runHandle));
}
export function registerSpawnAsyncCommandSandboxPolicy(input) {
    registerAsyncCommandSandboxPolicy({
        sourceAgentFolder: input.sourceAgentFolder,
        runHandle: input.runHandle,
        policy: {
            appId: input.appId,
            agentId: input.agentId,
            conversationId: input.conversationId,
            providerAccountId: input.providerAccountId ?? null,
            threadId: input.threadId ?? null,
            runId: input.runId,
            correlationRunId: input.correlationRunId,
            jobId: input.jobId,
            protectedReadPaths: input.protectedReadPaths,
            protectedWritePaths: input.protectedWritePaths,
            allowedNetworkHosts: input.allowedNetworkHosts,
            resourceLimits: input.resourceLimits,
        },
    });
}
export function configureSpawnAsyncCommandSandboxPolicy(input) {
    const allowedNetworkHosts = input.gatewayAllowedNetworkHosts ?? input.fallbackAllowedNetworkHosts;
    input.env.GANTRY_SANDBOX_ALLOWED_NETWORK_HOSTS_JSON =
        JSON.stringify(allowedNetworkHosts);
    input.env.GANTRY_SANDBOX_RESOURCE_LIMITS_JSON = JSON.stringify(input.resourceLimits);
    registerSpawnAsyncCommandSandboxPolicy({
        sourceAgentFolder: input.sourceAgentFolder,
        runHandle: input.runHandle,
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        providerAccountId: input.providerAccountId,
        threadId: input.threadId,
        runId: input.runId,
        correlationRunId: input.correlationRunId,
        jobId: input.jobId,
        protectedReadPaths: input.protectedReadPaths,
        protectedWritePaths: input.protectedWritePaths,
        allowedNetworkHosts,
        resourceLimits: input.resourceLimits,
    });
    return allowedNetworkHosts;
}
function policyKey(sourceAgentFolder, runHandle) {
    return `${sourceAgentFolder}\0${runHandle}`;
}
