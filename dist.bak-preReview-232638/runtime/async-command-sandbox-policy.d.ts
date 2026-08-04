import type { RunnerSandboxResourceLimits } from '../shared/runner-sandbox-provider.js';
export interface AsyncCommandSandboxPolicy {
    appId: string;
    agentId?: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    runId?: string;
    correlationRunId?: string;
    jobId?: string;
    protectedReadPaths: readonly string[];
    protectedWritePaths: readonly string[];
    allowedNetworkHosts: readonly string[];
    resourceLimits: RunnerSandboxResourceLimits;
}
export declare function registerAsyncCommandSandboxPolicy(input: {
    sourceAgentFolder: string;
    runHandle: string;
    policy: AsyncCommandSandboxPolicy;
}): void;
export declare function readAsyncCommandSandboxPolicy(input: {
    sourceAgentFolder: string;
    runHandle?: string;
}): AsyncCommandSandboxPolicy | undefined;
export declare function registerSpawnAsyncCommandSandboxPolicy(input: {
    sourceAgentFolder: string;
    runHandle: string;
    appId: string;
    agentId?: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    runId?: string;
    correlationRunId?: string;
    jobId?: string;
    protectedReadPaths: readonly string[];
    protectedWritePaths: readonly string[];
    allowedNetworkHosts: readonly string[];
    resourceLimits: RunnerSandboxResourceLimits;
}): void;
export declare function configureSpawnAsyncCommandSandboxPolicy(input: {
    env: NodeJS.ProcessEnv;
    sourceAgentFolder: string;
    runHandle: string;
    appId: string;
    agentId?: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    runId?: string;
    correlationRunId?: string;
    jobId?: string;
    protectedReadPaths: readonly string[];
    protectedWritePaths: readonly string[];
    gatewayAllowedNetworkHosts?: readonly string[];
    fallbackAllowedNetworkHosts: readonly string[];
    resourceLimits: RunnerSandboxResourceLimits;
}): readonly string[];
