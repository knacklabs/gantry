import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { McpServerRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { RemoteMcpDnsValidationCache } from './mcp-server-policy.js';
import { type DetailedMcpTool, type ListedMcpTool, type McpToolListDiagnostics } from './mcp-tool-inventory.js';
export { clearMcpToolProxyInventoryCache } from './mcp-tool-inventory.js';
export { assertMcpNetworkHostAllowed, createGuardedMcpFetch, } from './mcp-tool-proxy-network.js';
interface McpToolCallInput {
    appId: AppId;
    agentId: AgentId;
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
}
export type McpToolSearchMatch = ListedMcpTool & {
    coveredByReviewedCapability: boolean;
    reviewedCapabilityIds?: string[];
};
export interface McpToolSearchResult {
    query: string;
    limit: number;
    total: number;
    matches: McpToolSearchMatch[];
    deferredServers?: string[];
}
export declare class McpToolProxy {
    private readonly mcpServers;
    private readonly options;
    constructor(mcpServers: McpServerRepository, options: {
        tools: ToolCatalogRepository;
        skills?: SkillCatalogRepository;
        credentialEnv?: Record<string, string>;
        liveToolRules?: readonly string[];
        sourceServerIds?: readonly string[];
        lookupHostname?: HostnameLookup;
        dnsValidationCache?: RemoteMcpDnsValidationCache;
        egressDenylist?: readonly string[];
        publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
        runId?: string;
        runHandle?: string;
    });
    listTools(input: {
        appId: AppId;
        agentId: AgentId;
        serverName?: string;
        query?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{
        servers: Array<{
            name: string;
            tools: ListedMcpTool[];
        }>;
        serverName?: string;
        query?: string;
        limit: number;
        cursor?: string;
        nextCursor?: string;
        total: number;
        deferredServers?: string[];
        diagnostics: McpToolListDiagnostics;
    }>;
    searchTools(input: {
        appId: AppId;
        agentId: AgentId;
        query: string;
        limit?: number;
    }): Promise<McpToolSearchResult>;
    describeTool(input: {
        appId: AppId;
        agentId: AgentId;
        serverName: string;
        toolName: string;
    }): Promise<DetailedMcpTool>;
    callTool(input: McpToolCallInput): Promise<unknown>;
    assertToolAllowed(input: McpToolCallInput): Promise<void>;
    private fetchAndCacheInventory;
    private publishMcpToolActivity;
    private materializeSourceCapabilities;
    private materializeReviewedCapabilities;
    private resolveReviewedTool;
    private connect;
    private createTransport;
    private assertNetworkAllowedForCapability;
}
