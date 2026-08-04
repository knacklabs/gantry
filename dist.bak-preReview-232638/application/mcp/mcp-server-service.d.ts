import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentMcpServerBinding, McpCredentialRef, McpServerDefinition, McpServerId, McpServerTransportConfig } from '../../domain/mcp/mcp-servers.js';
import type { AgentRepository, McpServerRepository } from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import { RemoteMcpDnsValidationCache } from './mcp-server-policy.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { type MaterializedMcpCapability } from './mcp-server-materialization.js';
export type { MaterializedMcpCapability } from './mcp-server-materialization.js';
export declare class McpServerService {
    private readonly mcpServers;
    private readonly agents?;
    private readonly options;
    constructor(mcpServers: McpServerRepository, agents?: AgentRepository | undefined, options?: {
        lookupHostname?: HostnameLookup;
        dnsValidationCache?: RemoteMcpDnsValidationCache;
        dnsLookupTimeoutMs?: number;
        auditMaterialization?: boolean;
    });
    connectServer(input: {
        appId: AppId;
        name: string;
        displayName?: string;
        description?: string;
        createdBy?: string;
        createdSource?: McpServerDefinition['createdSource'];
        requestedReason?: string;
        transportConfig: McpServerTransportConfig;
        allowedToolPatterns?: string[];
        autoApproveToolPatterns?: string[];
        credentialRefs?: McpCredentialRef[];
        networkHosts?: string[];
        sandboxProfileId?: string;
        riskClass?: McpServerDefinition['riskClass'];
    }): Promise<McpServerDefinition>;
    listServers(input: {
        appId: AppId;
        statuses?: McpServerDefinition['status'][];
        limit?: number;
        cursor?: string;
    }): Promise<McpServerDefinition[]>;
    disableServer(input: {
        appId: AppId;
        serverId: McpServerId;
        disabledBy?: string;
        reason?: string;
    }): Promise<McpServerDefinition>;
    testServer(input: {
        appId: AppId;
        serverId: McpServerId;
        testedBy?: string;
    }): Promise<{
        server: McpServerDefinition;
        ok: true;
        message: string;
    }>;
    bindToAgent(input: {
        appId: AppId;
        agentId: AgentId;
        serverId: McpServerId;
        required?: boolean;
        permissionPolicyIds?: PermissionPolicyId[];
        allowedToolPatterns?: string[];
    }): Promise<AgentMcpServerBinding>;
    unbindFromAgent(input: {
        appId: AppId;
        agentId: AgentId;
        serverId: McpServerId;
    }): Promise<AgentMcpServerBinding | null>;
    rollbackBinding(input: {
        appId: AppId;
        agentId: AgentId;
        serverId: McpServerId;
    }): Promise<void>;
    rollbackConnectedServer(input: {
        appId: AppId;
        agentId: AgentId;
        serverId: McpServerId;
    }): Promise<void>;
    listAgentBindings(input: {
        appId: AppId;
        agentId: AgentId;
        limit?: number;
        cursor?: string;
    }): Promise<AgentMcpServerBinding[]>;
    materializeForAgent(input: {
        appId: AppId;
        agentId: AgentId;
        serverIds?: readonly McpServerId[];
        credentialEnv?: Record<string, string>;
    }): Promise<MaterializedMcpCapability[]>;
    private materializeOne;
    requireServer(appId: AppId, serverId: McpServerId): Promise<McpServerDefinition>;
    private assertAgentInApp;
    private audit;
}
