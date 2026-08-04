import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ReviewedMaterializedMcpCapability } from './mcp-tool-authorization.js';
import type { McpToolListClient } from './mcp-tool-list-fetch.js';
import { type CachedMcpToolDetail } from './mcp-tool-inventory.js';
export declare function fetchAndCacheMcpToolDetail(input: {
    request: {
        appId: AppId;
        agentId: AgentId;
        serverName: string;
        toolName: string;
    };
    capability: ReviewedMaterializedMcpCapability;
    client: McpToolListClient;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<CachedMcpToolDetail>;
export declare function resolveMcpToolOutputSchema(input: {
    request: {
        appId: AppId;
        agentId: AgentId;
        serverName: string;
        toolName: string;
    };
    capability: ReviewedMaterializedMcpCapability;
    client: McpToolListClient;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<unknown | undefined>;
