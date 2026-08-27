import type { RunnerSandboxResourceLimits } from '../shared/runner-sandbox-provider.js';
import type { CallerResolvedToolsConfig } from '../domain/types.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';

const WEBSITE_RECIPE_EVALUATOR_CAPABILITY_ID =
  'manipal.website-recipe-evaluator';

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
  browserPolicy?: 'recipe_authoring';
  resourceLimits: RunnerSandboxResourceLimits;
  callerResolvedTools?: CallerResolvedToolsConfig;
}

const policies = new Map<string, AsyncCommandSandboxPolicy>();

export function browserPolicyFromSemanticCapabilities(
  semanticCapabilities: readonly SemanticCapabilityDefinition[] | undefined,
): 'recipe_authoring' | undefined {
  return semanticCapabilities?.some(
    (capability) =>
      capability.capabilityId === WEBSITE_RECIPE_EVALUATOR_CAPABILITY_ID &&
      capability.version === '1',
  )
    ? 'recipe_authoring'
    : undefined;
}

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

export function grantAsyncCommandBrowserHost(input: {
  sourceAgentFolder: string;
  runHandle: string;
  jobId: string;
  runId: string;
  host: string;
}): boolean {
  const key = policyKey(input.sourceAgentFolder, input.runHandle);
  const policy = policies.get(key);
  if (
    !policy ||
    policy.browserPolicy !== 'recipe_authoring' ||
    policy.jobId !== input.jobId ||
    policy.runId !== input.runId
  ) {
    return false;
  }
  policies.set(key, {
    ...policy,
    allowedNetworkHosts: [
      ...new Set([...policy.allowedNetworkHosts, input.host]),
    ],
  });
  return true;
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
  correlationRunId?: string;
  jobId?: string;
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  allowedNetworkHosts: readonly string[];
  browserPolicy?: 'recipe_authoring';
  resourceLimits: RunnerSandboxResourceLimits;
  callerResolvedTools?: CallerResolvedToolsConfig;
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
      correlationRunId: input.correlationRunId,
      jobId: input.jobId,
      protectedReadPaths: input.protectedReadPaths,
      protectedWritePaths: input.protectedWritePaths,
      allowedNetworkHosts: input.allowedNetworkHosts,
      browserPolicy: input.browserPolicy,
      resourceLimits: input.resourceLimits,
      callerResolvedTools: input.callerResolvedTools,
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
  correlationRunId?: string;
  jobId?: string;
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  gatewayAllowedNetworkHosts?: readonly string[];
  fallbackAllowedNetworkHosts: readonly string[];
  browserPolicy?: 'recipe_authoring';
  resourceLimits: RunnerSandboxResourceLimits;
  callerResolvedTools?: CallerResolvedToolsConfig;
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
    correlationRunId: input.correlationRunId,
    jobId: input.jobId,
    protectedReadPaths: input.protectedReadPaths,
    protectedWritePaths: input.protectedWritePaths,
    allowedNetworkHosts,
    browserPolicy: input.browserPolicy,
    resourceLimits: input.resourceLimits,
    callerResolvedTools: input.callerResolvedTools,
  });
  return allowedNetworkHosts;
}

function policyKey(sourceAgentFolder: string, runHandle: string): string {
  return `${sourceAgentFolder}\0${runHandle}`;
}
