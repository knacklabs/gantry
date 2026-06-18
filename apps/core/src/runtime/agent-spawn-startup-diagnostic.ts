import type { AppId } from '../domain/app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../domain/conversation/conversation.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '../domain/events/events.js';
import {
  normalizeRuntimeEventConversationId,
  normalizeRuntimeEventThreadId,
} from '../domain/events/runtime-event-conversation.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type { JobId } from '../domain/jobs/jobs.js';
import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import type { AgentEngine } from '../shared/agent-engine.js';
import type { RunnerSandboxProviderId } from '../shared/runner-sandbox-provider.js';
import type { RunnerStartupHostPhaseTimings } from './agent-spawn-startup-timing.js';
import type { AgentInput, RunAgentOptions } from './agent-spawn-types.js';

export interface RunnerHostStartupDiagnosticInput {
  appId: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId: string;
  threadId?: string;
  agentEngine: AgentEngine;
  executionProviderId: string;
  hostPhases: RunnerStartupHostPhaseTimings;
  toolPolicyRuleCount: number;
  gantryMcpToolCount: number;
  attachedMcpSourceCount: number;
  projectedMcpSourceCount: number;
  selectedMcpServerCount: number;
  materializedMcpServerCount: number;
  runnerVisibleMcpServerCount: number;
  reviewedMcpToolCount: number;
  mcpConfigProjected: boolean;
  mcpTransportCounts: {
    stdio: number;
    http: number;
    sse: number;
  };
  selectedSkillSourceCount: number;
  selectedSkillDisplayCount: number;
  selectedSkillSecretEnvCount: number;
  semanticCapabilityCount: number;
  runtimeAccessCount: number;
  browserIpcEnabled: boolean;
  memoryIpcActionCount: number;
  deepAgentCheckpointerConfigured: boolean;
  sandbox: {
    provider: RunnerSandboxProviderId;
    enforcing: boolean;
    allowedNetworkHostCount: number;
    protectedReadPathCount: number;
    protectedWritePathCount: number;
    localCliCredentialPathCount: number;
    warmTemplateAvailable: boolean;
    warmTemplateCacheHit: boolean;
  };
  egress: {
    proxyConfigured: boolean;
    upstreamProxyConfigured: boolean;
  };
  credentials: {
    brokerApplied: boolean;
    credentialProviderCount: number;
    modelCredentialEnvKeyCount: number;
  };
  prompt: {
    compiledSystemPromptChars: number;
  };
}

export function countJsonStringArray(value: unknown): number {
  if (typeof value !== 'string') return 0;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return 0;
    return parsed.filter((item): item is string => typeof item === 'string')
      .length;
  } catch {
    return 0;
  }
}

export function buildRunnerHostStartupDiagnosticEvent(
  input: RunnerHostStartupDiagnosticInput,
): RuntimeEventPublishInput {
  const conversationId = normalizeRuntimeEventConversationId(
    input.conversationId as ConversationId,
  );
  const threadId = normalizeRuntimeEventThreadId({
    conversationId,
    threadId: input.threadId as ConversationThreadId | undefined,
  });
  return {
    appId: input.appId as AppId,
    ...(input.agentId ? { agentId: input.agentId as never } : {}),
    ...(input.runId ? { runId: input.runId as AgentRunId } : {}),
    ...(input.jobId ? { jobId: input.jobId as JobId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(threadId ? { threadId } : {}),
    eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC as RuntimeEventType,
    actor: 'runtime',
    responseMode: 'none',
    payload: {
      provider: 'host',
      diagnostic: 'host_startup_projection',
      agentEngine: input.agentEngine,
      executionProviderId: input.executionProviderId,
      hostPhases: input.hostPhases,
      toolPolicyRuleCount: input.toolPolicyRuleCount,
      gantryMcpToolCount: input.gantryMcpToolCount,
      attachedMcpSourceCount: input.attachedMcpSourceCount,
      projectedMcpSourceCount: input.projectedMcpSourceCount,
      selectedMcpServerCount: input.selectedMcpServerCount,
      materializedMcpServerCount: input.materializedMcpServerCount,
      runnerVisibleMcpServerCount: input.runnerVisibleMcpServerCount,
      reviewedMcpToolCount: input.reviewedMcpToolCount,
      mcpConfigProjected: input.mcpConfigProjected,
      mcpTransportCounts: input.mcpTransportCounts,
      selectedSkillSourceCount: input.selectedSkillSourceCount,
      selectedSkillDisplayCount: input.selectedSkillDisplayCount,
      selectedSkillSecretEnvCount: input.selectedSkillSecretEnvCount,
      semanticCapabilityCount: input.semanticCapabilityCount,
      runtimeAccessCount: input.runtimeAccessCount,
      browserIpcEnabled: input.browserIpcEnabled,
      memoryIpcActionCount: input.memoryIpcActionCount,
      deepAgentCheckpointerConfigured: input.deepAgentCheckpointerConfigured,
      sandbox: input.sandbox,
      egress: input.egress,
      credentials: input.credentials,
      prompt: input.prompt,
    },
  };
}

export async function publishRunnerHostStartupDiagnosticFromSpawn(input: {
  publishRuntimeEvent?: RunAgentOptions['publishRuntimeEvent'];
  logger: {
    warn: (context: Record<string, unknown>, message: string) => void;
  };
  agentInput: AgentInput;
  runnerAppId: string;
  agentEngine: AgentEngine;
  executionProviderId: string;
  hostPhases: RunnerStartupHostPhaseTimings;
  snapshot: RunnerHostStartupDiagnosticSnapshot;
}): Promise<void> {
  if (!input.publishRuntimeEvent) return;
  const snapshot = input.snapshot;
  const diagnostic: RunnerHostStartupDiagnosticInput = {
    appId: input.runnerAppId,
    ...(input.agentInput.agentId ? { agentId: input.agentInput.agentId } : {}),
    ...(input.agentInput.runId ? { runId: input.agentInput.runId } : {}),
    ...(input.agentInput.jobId ? { jobId: input.agentInput.jobId } : {}),
    conversationId: input.agentInput.chatJid,
    ...(input.agentInput.threadId
      ? { threadId: input.agentInput.threadId }
      : {}),
    agentEngine: input.agentEngine,
    executionProviderId: input.executionProviderId,
    hostPhases: input.hostPhases,
    toolPolicyRuleCount: snapshot.trustedToolPolicyRules?.length ?? 0,
    gantryMcpToolCount: countJsonStringArray(
      snapshot.preparedEnv.GANTRY_MCP_TOOL_NAMES_JSON,
    ),
    attachedMcpSourceCount: snapshot.attachedMcpSourceIds.length,
    projectedMcpSourceCount: snapshot.projectedMcpSourceIds.length,
    selectedMcpServerCount: snapshot.selectedMcpServerNames.length,
    materializedMcpServerCount: snapshot.allMcpCapabilities.length,
    runnerVisibleMcpServerCount: snapshot.runnerVisibleMcpServerNames.length,
    reviewedMcpToolCount: snapshot.reviewedMcpToolNames.length,
    mcpConfigProjected: snapshot.mcpConfigPath !== undefined,
    mcpTransportCounts: mcpTransportCounts(snapshot.allMcpCapabilities),
    selectedSkillSourceCount:
      input.agentInput.attachedSkillSourceIds?.length ?? 0,
    selectedSkillDisplayCount:
      input.agentInput.selectedSkillDisplays?.length ?? 0,
    selectedSkillSecretEnvCount: Object.keys(snapshot.selectedSkillEnv.env)
      .length,
    semanticCapabilityCount:
      snapshot.runnerInput.semanticCapabilities?.length ?? 0,
    runtimeAccessCount: snapshot.effectiveRuntimeAccess.length,
    browserIpcEnabled: snapshot.browserIpcEnabled,
    memoryIpcActionCount: snapshot.memoryIpcAllowedActions.length,
    deepAgentCheckpointerConfigured:
      snapshot.runnerInput.deepAgentCheckpointer !== undefined,
    sandbox: {
      provider: snapshot.runnerSandboxProviderId,
      enforcing: snapshot.runnerSandboxEnforcing,
      allowedNetworkHostCount: snapshot.finalAllowedNetworkHosts.length,
      protectedReadPathCount: snapshot.sandboxProtectedReadPaths.length,
      protectedWritePathCount: snapshot.sandboxProtectedWritePaths.length,
      localCliCredentialPathCount: snapshot.localCliCredentialPaths.length,
      warmTemplateAvailable: snapshot.sandboxWarmTemplate.available,
      warmTemplateCacheHit: snapshot.sandboxWarmTemplate.cacheHit,
    },
    egress: {
      proxyConfigured: snapshot.egressProxyConfigured,
      upstreamProxyConfigured: snapshot.upstreamProxyConfigured,
    },
    credentials: {
      brokerApplied: snapshot.hostCredentials.brokerApplied,
      credentialProviderCount: Object.keys(
        snapshot.hostCredentials.credentialProviders,
      ).length,
      modelCredentialEnvKeyCount: Object.keys(
        snapshot.runnerInput.modelCredentialEnv ?? {},
      ).length,
    },
    prompt: {
      compiledSystemPromptChars: snapshot.compiledSystemPrompt.length,
    },
  };
  try {
    await input.publishRuntimeEvent(
      buildRunnerHostStartupDiagnosticEvent(diagnostic),
    );
  } catch (err) {
    input.logger.warn(
      {
        err,
        appId: diagnostic.appId,
        agentId: diagnostic.agentId,
        runId: diagnostic.runId,
      },
      'Runner host startup diagnostic persistence failed',
    );
  }
}

export interface RunnerHostStartupDiagnosticSnapshot {
  trustedToolPolicyRules?: readonly string[];
  preparedEnv: NodeJS.ProcessEnv;
  attachedMcpSourceIds: readonly string[];
  projectedMcpSourceIds: readonly string[];
  selectedMcpServerNames: readonly string[];
  allMcpCapabilities: readonly MaterializedMcpCapability[];
  runnerVisibleMcpServerNames: readonly string[];
  reviewedMcpToolNames: readonly string[];
  mcpConfigPath?: string;
  selectedSkillEnv: { env: Record<string, string> };
  runnerInput: {
    semanticCapabilities?: readonly unknown[];
    deepAgentCheckpointer?: unknown;
    modelCredentialEnv?: Record<string, string>;
  };
  effectiveRuntimeAccess: readonly unknown[];
  browserIpcEnabled: boolean;
  memoryIpcAllowedActions: readonly string[];
  runnerSandboxProviderId: RunnerSandboxProviderId;
  runnerSandboxEnforcing: boolean;
  finalAllowedNetworkHosts: readonly string[];
  sandboxProtectedReadPaths: readonly string[];
  sandboxProtectedWritePaths: readonly string[];
  localCliCredentialPaths: readonly string[];
  sandboxWarmTemplate: {
    available: boolean;
    cacheHit: boolean;
  };
  egressProxyConfigured: boolean;
  upstreamProxyConfigured: boolean;
  hostCredentials: {
    brokerApplied: boolean;
    credentialProviders: Record<string, unknown>;
  };
  compiledSystemPrompt: string;
}

function mcpTransportCounts(
  capabilities: readonly MaterializedMcpCapability[],
) {
  return capabilities.reduce(
    (counts, capability) => {
      const type = capability.config.type ?? 'stdio';
      counts[type] += 1;
      return counts;
    },
    { stdio: 0, http: 0, sse: 0 },
  );
}
