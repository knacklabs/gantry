import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AgentMcpServerBinding, McpServerDefinition, McpServerId } from '../../domain/mcp/mcp-servers.js';
export declare function nextMcpSourceBindings(input: {
    appId: AppId;
    agentId: AgentId;
    sources: Array<{
        id: string;
        tools?: string[];
    }>;
    servers: ReadonlyMap<McpServerId, McpServerDefinition>;
    existingBindings: AgentMcpServerBinding[];
    now: string;
}): AgentMcpServerBinding[];
