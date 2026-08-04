import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type { ConversationId, ConversationThreadId } from '../conversation/conversation.js';
import type { PermissionPolicyId } from '../permissions/permissions.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
export type McpServerId = BrandedId<'McpServerId'>;
export type AgentMcpServerBindingId = BrandedId<'AgentMcpServerBindingId'>;
export type McpServerAuditEventId = BrandedId<'McpServerAuditEventId'>;
export type McpServerStatus = 'active' | 'disabled';
export type McpServerCreatedSource = 'admin' | 'agent_request';
export type McpServerTransport = 'http' | 'sse' | 'stdio_template';
export type McpServerRiskClass = 'low' | 'medium' | 'high';
export type AgentMcpServerBindingStatus = 'active' | 'disabled';
export interface McpServerTransportConfig {
    transport: McpServerTransport;
    url?: string;
    templateId?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
}
export interface McpCredentialRef {
    name: string;
    target: 'env' | 'header';
    key: string;
}
export interface McpServerDefinition {
    id: McpServerId;
    appId: AppId;
    name: string;
    displayName?: string;
    description?: string;
    status: McpServerStatus;
    createdSource: McpServerCreatedSource;
    riskClass: McpServerRiskClass;
    requestedBy?: string;
    requestedReason?: string;
    transport: McpServerTransport;
    config: McpServerTransportConfig;
    allowedToolPatterns: string[];
    autoApproveToolPatterns: string[];
    credentialRefs: McpCredentialRef[];
    networkHosts: string[];
    sandboxProfileId?: string;
    createdAt: IsoTimestamp;
    updatedAt: IsoTimestamp;
    disabledBy?: string;
    disabledAt?: IsoTimestamp;
}
export interface AgentMcpServerBinding {
    id: AgentMcpServerBindingId;
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    status: AgentMcpServerBindingStatus;
    required: boolean;
    permissionPolicyIds: PermissionPolicyId[];
    allowedToolPatterns: string[];
    conversationId?: ConversationId;
    threadId?: ConversationThreadId;
    createdAt: IsoTimestamp;
    updatedAt: IsoTimestamp;
}
export type McpServerAuditEventType = 'request' | 'connect' | 'request_reject' | 'bind' | 'unbind' | 'disable' | 'test' | 'materialize' | 'startup_failure' | 'permission_allow' | 'permission_deny' | 'tool_activity';
export interface McpServerAuditEvent {
    id: McpServerAuditEventId;
    appId: AppId;
    agentId?: AgentId;
    serverId?: McpServerId;
    bindingId?: AgentMcpServerBindingId;
    eventType: McpServerAuditEventType;
    actorId?: string;
    reason?: string;
    metadata: Record<string, unknown>;
    createdAt: IsoTimestamp;
}
export interface MaterializedMcpServer {
    definition: McpServerDefinition;
    binding: AgentMcpServerBinding;
}
export declare function assertValidMcpServerName(name: string): void;
export declare function normalizeMcpServerName(name: string): string;
export declare function assertNoRawSecretsInMcpConfig(value: unknown, path?: string): void;
export declare function isMcpServerActive(definition: McpServerDefinition): boolean;
