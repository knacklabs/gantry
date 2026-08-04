import { type AgentPersona } from '../../../shared/agent-persona.js';
import type { SemanticCapabilityDefinition } from '../../../shared/semantic-capabilities.js';
import { type CallableAgentToolManifestEntry } from '../../../shared/callable-agent-manifest.js';
export interface AgentCapabilityContext {
    mcpServerPath: string;
    appId?: string;
    agentId?: string;
    chatJid: string;
    workspaceFolder: string;
    threadId?: string;
    jobId?: string;
    runHandle?: string;
    runId?: string;
    parentTaskId?: string;
    callableAgentManifest?: readonly CallableAgentToolManifestEntry[];
    runLeaseToken?: string;
    runLeaseFencingVersion?: number;
    liveStopActionToken?: string;
    memoryUserId?: string;
    memoryDefaultScope?: 'user' | 'group';
    memoryReviewerIsControlApprover?: boolean;
    persona?: AgentPersona;
    browserProfileName?: string;
    configuredAllowedTools?: readonly string[];
    attachedSkillSourceIds?: readonly string[];
    selectedSkillDisplays?: readonly string[];
    attachedMcpSourceIds?: readonly string[];
    semanticCapabilities?: readonly SemanticCapabilityDefinition[];
    hideAuthorityTools?: boolean;
    asyncTaskToolsEnabled?: boolean;
    memoryBlock?: string;
    accessPreset?: 'full' | 'locked';
    ipcDir?: string;
    ipcAuthToken?: string;
    browserIpcAuthToken?: string;
    memoryIpcAuthToken?: string;
    ipcResponseVerifyKey?: string;
    ipcResponseKeyId?: string;
    externalMcpServers?: Record<string, McpServerConfig>;
    externalMcpAllowedTools?: readonly string[];
    externalMcpAlwaysAllowedTools?: readonly string[];
    isScheduledJob?: boolean;
}
export type McpServerConfig = {
    type?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;
    alwaysLoad?: boolean;
} | {
    type: 'http' | 'sse';
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
    alwaysLoad?: boolean;
};
export interface AgentCapabilityProfile {
    allowedTools: readonly string[];
    availableTools: readonly string[];
    disallowedTools: readonly string[];
    mcpServers: Record<string, McpServerConfig>;
    permissionMode: 'default' | 'deny';
    alwaysAllowedTools: readonly string[];
}
export interface AgentCapabilityProvider {
    id: string;
    provide: (ctx: AgentCapabilityContext) => Partial<AgentCapabilityProfile>;
}
export declare function isPublicExternalMcpToolRule(toolRule: string): boolean;
export declare const BUILTIN_AGENT_CAPABILITY_PROVIDERS: readonly AgentCapabilityProvider[];
export declare function composeAgentCapabilities(ctx: AgentCapabilityContext, providers?: readonly AgentCapabilityProvider[]): AgentCapabilityProfile;
