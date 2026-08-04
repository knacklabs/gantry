import { ConversationRoute } from '../domain/types.js';
import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { ConversationId, ConversationThreadId } from '../domain/conversation/conversation.js';
import type { AgentRunId } from '../domain/events/events.js';
import type { JobId } from '../domain/jobs/jobs.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { AgentCredentialPurpose, AgentCredentialInjection, CredentialBrokerProfile } from '../domain/models/credentials.js';
import type { ModelRouteId } from '../shared/model-catalog.js';
import { type PermissionMode } from '../shared/permission-mode.js';
import { AgentInput, type AgentOutput, HostRuntimeContext } from './agent-spawn-types.js';
export interface HostRuntimeCredentialEnvOptions {
    purpose?: AgentCredentialPurpose;
    appId?: AppId;
    agentId?: AgentId;
    runId?: AgentRunId;
    jobId?: JobId;
    conversationId?: ConversationId;
    threadId?: ConversationThreadId;
    modelRouteId?: ModelRouteId;
    runContext?: Pick<AgentInput, 'appId' | 'agentId' | 'runId' | 'jobId' | 'chatJid' | 'threadId'>;
}
export declare function getConfiguredAgentMaxRunTokens(agentFolder: string): number | undefined;
export declare function createConfiguredRunTokenBudget(agentFolder: string): {
    readonly exceeded: boolean;
    enforce(output: AgentOutput): AgentOutput;
};
export declare function withControls(input: AgentInput, defaults?: {
    effort?: AgentInput['effort'];
    thinking?: AgentInput['configuredThinking'];
    maxOutputTokens?: number;
    toolRules?: AgentInput['toolRules'];
    permissionMode?: AgentInput['permissionMode'];
}, conversationPermissionMode?: AgentInput['permissionMode']): AgentInput & {
    permissionMode: PermissionMode;
};
export declare function prepareInlineAgentHostContext(group: ConversationRoute, input: AgentInput): Promise<{
    toolRules?: import("./agent-spawn-types.js").AgentToolRule[] | undefined;
    resolvedModel: import("../application/model-resolution/llm-profile-resolution-service.js").LlmProfileResolution;
    compiledSystemPrompt: string | undefined;
    dataDir: string;
    defaultTimeoutMs: number;
    idleTimeoutMs: number;
    sandboxProvider: import("../config/settings/runtime-settings-types.js").RuntimeSandboxProvider;
    maxTurns: number | undefined;
    effort: import("../domain/types.js").AgentControlEffort | undefined;
    configuredThinking: import("../domain/types.js").AgentControlThinking | undefined;
    maxOutputTokens: number | undefined;
    permissionMode: "ask" | "auto" | "auto_strict";
}>;
export declare function getHostRuntimeCredentialEnv(agentIdentifier?: string, broker?: AgentCredentialBroker, options?: HostRuntimeCredentialEnvOptions): Promise<{
    env: Record<string, string>;
    credentialProviders: NonNullable<AgentCredentialInjection['credentialProviders']>;
    proxy?: AgentCredentialInjection['proxy'];
    brokerApplied: boolean;
    brokerProfile: CredentialBrokerProfile;
    brokerAuthMode?: string;
    revoke?: () => Promise<void>;
}>;
export declare function prepareHostRuntimeContext(group: ConversationRoute): HostRuntimeContext;
