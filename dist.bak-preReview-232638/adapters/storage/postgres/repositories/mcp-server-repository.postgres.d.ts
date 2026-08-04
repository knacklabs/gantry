import type { McpServerRepository } from '../../../../domain/ports/repositories.js';
import type { AgentMcpServerBinding, MaterializedMcpServer, McpServerAuditEvent, McpServerDefinition, McpServerId } from '../../../../domain/mcp/mcp-servers.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresMcpServerRepository implements McpServerRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getServer(id: McpServerId): Promise<McpServerDefinition | null>;
    getServerByName(input: {
        appId: McpServerDefinition['appId'];
        name: string;
    }): Promise<McpServerDefinition | null>;
    listServers(input: {
        appId: McpServerDefinition['appId'];
        statuses?: McpServerDefinition['status'][];
        limit?: number;
        cursor?: string;
    }): Promise<McpServerDefinition[]>;
    saveServer(definition: McpServerDefinition): Promise<void>;
    transitionServerStatus(input: {
        appId: McpServerDefinition['appId'];
        serverId: McpServerId;
        expectedStatus: McpServerDefinition['status'];
        next: McpServerDefinition;
    }): Promise<McpServerDefinition | null>;
    saveAgentBinding(binding: AgentMcpServerBinding): Promise<void>;
    disableAgentBinding(input: {
        appId: AgentMcpServerBinding['appId'];
        agentId: AgentMcpServerBinding['agentId'];
        serverId: AgentMcpServerBinding['serverId'];
        updatedAt: string;
    }): Promise<AgentMcpServerBinding | null>;
    listAgentBindings(input: {
        appId: AgentMcpServerBinding['appId'];
        agentId: AgentMcpServerBinding['agentId'];
        limit?: number;
        cursor?: string;
    }): Promise<AgentMcpServerBinding[]>;
    listAgentBindingsForAgents(input: {
        appId: AgentMcpServerBinding['appId'];
        agentIds: readonly AgentMcpServerBinding['agentId'][];
        limitPerAgent?: number;
    }): Promise<AgentMcpServerBinding[]>;
    private listAgentBindingRows;
    listMaterializedServersForAgent(input: {
        appId: AgentMcpServerBinding['appId'];
        agentId: AgentMcpServerBinding['agentId'];
        serverIds?: readonly McpServerId[];
    }): Promise<MaterializedMcpServer[]>;
    appendAuditEvent(event: McpServerAuditEvent): Promise<void>;
    listAuditEvents(input: {
        appId: McpServerAuditEvent['appId'];
        serverId?: McpServerId;
        limit?: number;
        cursor?: string;
    }): Promise<McpServerAuditEvent[]>;
    private mapServer;
    private mapBinding;
    private mapAuditEvent;
}
