import type { RuntimeEventPublishInput } from '../domain/events/events.js';
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
export declare function countJsonStringArray(value: unknown): number;
export declare function buildRunnerHostStartupDiagnosticEvent(input: RunnerHostStartupDiagnosticInput): RuntimeEventPublishInput;
export declare function publishRunnerHostStartupDiagnosticFromSpawn(input: {
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
}): Promise<void>;
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
    selectedSkillEnv: {
        env: Record<string, string>;
    };
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
