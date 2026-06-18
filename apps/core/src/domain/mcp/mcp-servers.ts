import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';
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
  // Per-agent subset of the server definition's allowedToolPatterns. Empty means
  // the agent inherits the definition's full reviewed set; a non-empty list
  // scopes this agent to those operations (e.g. read-only vs read+write) without
  // duplicating the server definition.
  allowedToolPatterns: string[];
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type McpServerAuditEventType =
  | 'request'
  | 'connect'
  | 'request_reject'
  | 'bind'
  | 'unbind'
  | 'disable'
  | 'test'
  | 'materialize'
  | 'startup_failure'
  | 'permission_allow'
  | 'permission_deny'
  | 'tool_activity';

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

const MCP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const RESERVED_MCP_NAMES = new Set(['gantry']);
const SECRET_KEY_PATTERN =
  /(token|secret|password|credential|api[_-]?key|authorization|auth|bearer|cookie)/i;
const SECRET_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|[a-z0-9]+_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._\-~+/]+=*)/i;

export function assertValidMcpServerName(name: string): void {
  if (!MCP_NAME_PATTERN.test(name)) {
    throw new Error(
      'MCP server name must start with a lowercase letter and use only lowercase letters, numbers, underscore, or dash.',
    );
  }
  if (RESERVED_MCP_NAMES.has(name)) {
    throw new Error(`MCP server name is reserved: ${name}`);
  }
}

export function normalizeMcpServerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function assertNoRawSecretsInMcpConfig(
  value: unknown,
  path = 'config',
): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERN.test(value)) {
      throw new Error(
        `${path} contains a raw secret value. Use credentialRefs instead.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoRawSecretsInMcpConfig(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      SECRET_KEY_PATTERN.test(key) &&
      typeof entry === 'string' &&
      entry.trim()
    ) {
      throw new Error(
        `${path}.${key} looks like a raw secret. Use credentialRefs instead.`,
      );
    }
    assertNoRawSecretsInMcpConfig(entry, `${path}.${key}`);
  }
}

export function isMcpServerActive(definition: McpServerDefinition): boolean {
  return definition.status === 'active';
}
