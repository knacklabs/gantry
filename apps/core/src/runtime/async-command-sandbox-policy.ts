import type { RunnerSandboxResourceLimits } from '../shared/runner-sandbox-provider.js';

export interface AsyncCommandSandboxPolicy {
  appId: string;
  agentId?: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  runId?: string;
  jobId?: string;
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  allowedNetworkHosts: readonly string[];
  resourceLimits: RunnerSandboxResourceLimits;
}

const policies = new Map<string, AsyncCommandSandboxPolicy>();

export function registerAsyncCommandSandboxPolicy(input: {
  sourceAgentFolder: string;
  runHandle: string;
  policy: AsyncCommandSandboxPolicy;
}): void {
  policies.set(
    policyKey(input.sourceAgentFolder, input.runHandle),
    input.policy,
  );
}

export function readAsyncCommandSandboxPolicy(input: {
  sourceAgentFolder: string;
  runHandle?: string;
}): AsyncCommandSandboxPolicy | undefined {
  if (!input.runHandle) return undefined;
  return policies.get(policyKey(input.sourceAgentFolder, input.runHandle));
}

export function registerSpawnAsyncCommandSandboxPolicy(input: {
  sourceAgentFolder: string;
  runHandle: string;
  appId: string;
  agentId?: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  runId?: string;
  jobId?: string;
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  allowedNetworkHosts: readonly string[];
  resourceLimits: RunnerSandboxResourceLimits;
}): void {
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
      jobId: input.jobId,
      protectedReadPaths: input.protectedReadPaths,
      protectedWritePaths: input.protectedWritePaths,
      allowedNetworkHosts: input.allowedNetworkHosts,
      resourceLimits: input.resourceLimits,
    },
  });
}

export function configureSpawnAsyncCommandSandboxPolicy(input: {
  env: NodeJS.ProcessEnv;
  sourceAgentFolder: string;
  runHandle: string;
  appId: string;
  agentId?: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  runId?: string;
  jobId?: string;
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  gatewayAllowedNetworkHosts?: readonly string[];
  fallbackAllowedNetworkHosts: readonly string[];
  resourceLimits: RunnerSandboxResourceLimits;
}): readonly string[] {
  const allowedNetworkHosts =
    input.gatewayAllowedNetworkHosts ?? input.fallbackAllowedNetworkHosts;
  input.env.GANTRY_SANDBOX_ALLOWED_NETWORK_HOSTS_JSON =
    JSON.stringify(allowedNetworkHosts);
  input.env.GANTRY_SANDBOX_RESOURCE_LIMITS_JSON = JSON.stringify(
    input.resourceLimits,
  );
  registerSpawnAsyncCommandSandboxPolicy({
    sourceAgentFolder: input.sourceAgentFolder,
    runHandle: input.runHandle,
    appId: input.appId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    providerAccountId: input.providerAccountId,
    threadId: input.threadId,
    runId: input.runId,
    jobId: input.jobId,
    protectedReadPaths: input.protectedReadPaths,
    protectedWritePaths: input.protectedWritePaths,
    allowedNetworkHosts,
    resourceLimits: input.resourceLimits,
  });
  return allowedNetworkHosts;
}

function policyKey(sourceAgentFolder: string, runHandle: string): string {
  return `${sourceAgentFolder}\0${runHandle}`;
}
