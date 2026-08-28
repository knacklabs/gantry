import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpServerAuditEvent,
  McpServerDefinition,
  McpServerId,
} from '../mcp/mcp-servers.js';

export interface McpServerRepository {
  withMcpCapabilityApprovalLock?<T>(input: {
    appId: AppId;
    serverNames: readonly string[];
    operation: () => Promise<T>;
  }): Promise<T>;
  withMcpCapabilityAuthorizationLock?<T>(input: {
    appId: AppId;
    operation: () => Promise<T>;
  }): Promise<T>;
  getServer(id: McpServerId): Promise<McpServerDefinition | null>;
  getServerByName(input: {
    appId: AppId;
    name: string;
  }): Promise<McpServerDefinition | null>;
  listServers(input: {
    appId: AppId;
    statuses?: McpServerDefinition['status'][];
    limit?: number;
    cursor?: string;
  }): Promise<McpServerDefinition[]>;
  summarizeNavigation?(appId: AppId): Promise<{
    active: number;
    disabled: number;
  }>;
  saveServer(definition: McpServerDefinition): Promise<void>;
  transitionServerStatus(input: {
    appId: AppId;
    serverId: McpServerId;
    expectedStatus: McpServerDefinition['status'];
    next: McpServerDefinition;
  }): Promise<McpServerDefinition | null>;
  getAgentBinding(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
  }): Promise<AgentMcpServerBinding | null>;
  saveAgentBinding(binding: AgentMcpServerBinding): Promise<void>;
  saveAgentBindingsBatch(bindings: AgentMcpServerBinding[]): Promise<void>;
  disableAgentBinding(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    updatedAt: string;
  }): Promise<AgentMcpServerBinding | null>;
  listAgentBindings(input: {
    appId: AppId;
    agentId: AgentId;
    limit?: number;
    cursor?: string;
  }): Promise<AgentMcpServerBinding[]>;
  listAgentMcpAccessSnapshot(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentMcpAccessSnapshot>;
  listAgentBindingsForAgents(input: {
    appId: AppId;
    agentIds: readonly AgentId[];
    limitPerAgent?: number;
  }): Promise<AgentMcpServerBinding[]>;
  listMaterializedServersForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverIds?: readonly McpServerId[];
  }): Promise<MaterializedMcpServer[]>;
  appendAuditEvent(event: McpServerAuditEvent): Promise<void>;
  listAuditEvents(input: {
    appId: AppId;
    serverId?: McpServerId;
    limit?: number;
    cursor?: string;
  }): Promise<McpServerAuditEvent[]>;
}

export interface AgentMcpAccessSnapshot {
  activeBindings: ReadonlyArray<{
    binding: AgentMcpServerBinding;
    definition: McpServerDefinition | null;
  }>;
  materializedServers: readonly MaterializedMcpServer[];
}
