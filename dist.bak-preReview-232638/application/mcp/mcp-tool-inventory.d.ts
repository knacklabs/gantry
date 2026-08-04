import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { MaterializedMcpCapability } from './mcp-server-service.js';
export type ListedMcpTool = {
    name: string;
    description?: string;
    toolRef: string;
    serverName: string;
    sourceId: string;
    callable: false;
    denialReason: string;
};
export type DetailedMcpTool = ListedMcpTool & {
    metadataAuthority: 'untrusted_mcp_server';
    title?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: unknown;
    diagnostics?: McpToolDetailDiagnostics;
};
export type McpToolListDiagnostics = {
    connectedServerCount: number;
    deferredServerCount: number;
    inventoryCacheHits: number;
    inventoryCacheMisses: number;
    liveListCalls: number;
    liveListMs: number;
    remoteListPageCount: number;
    remoteListTruncated: boolean;
    discoveredToolCount: number;
    loadedToolCount: number;
    selectedToolCount: number;
    returnedToolCount: number;
};
export type McpToolDetailDiagnostics = {
    detailCacheHits: number;
    detailCacheMisses: number;
    liveDetailCalls: number;
    liveDetailMs: number;
    metadataBytes: number | 'unavailable';
};
export type CachedMcpInventory = {
    expiresAt: number;
    tools: ListedMcpTool[];
    totalAllowed: number;
    remoteListPageCount: number;
    remoteListTruncated: boolean;
};
export type CachedMcpToolDetail = {
    expiresAt: number;
    tool: Omit<DetailedMcpTool, 'diagnostics'>;
    metadataBytes: number | 'unavailable';
};
type McpInventoryCapability = Pick<MaterializedMcpCapability, 'name' | 'sourceRevision' | 'config' | 'allowedToolPatterns' | 'allowedToolNames'> & {
    reviewedToolNames: string[];
};
export declare const MCP_SOURCE_INVENTORY_DENIAL_REASON = "Source inventory only; mcp_call_tool rechecks reviewed current-run action capability at call time.";
export declare function clearMcpToolProxyInventoryCache(): void;
export declare function invalidateMcpToolProxyInventoryCacheForCapability(capability: Pick<MaterializedMcpCapability, 'name' | 'config'>): number;
export declare function cacheMcpInventory(input: {
    appId: AppId;
    agentId: AgentId;
}, capability: McpInventoryCapability, inventory: Omit<CachedMcpInventory, 'expiresAt'>): CachedMcpInventory;
export declare function readCachedMcpInventory(input: {
    appId: AppId;
    agentId: AgentId;
}, capability: McpInventoryCapability): CachedMcpInventory | undefined;
export declare function cacheMcpToolDetail(input: {
    appId: AppId;
    agentId: AgentId;
}, capability: McpInventoryCapability, toolName: string, detail: Omit<CachedMcpToolDetail, 'expiresAt'>): CachedMcpToolDetail;
export declare function readCachedMcpToolDetail(input: {
    appId: AppId;
    agentId: AgentId;
}, capability: McpInventoryCapability, toolName: string): CachedMcpToolDetail | undefined;
export declare function approximateMcpMetadataBytes(value: unknown): number | 'unavailable';
export declare function normalizeMcpListLimit(limit: number | undefined): number;
export declare function normalizeMcpListCursor(cursor: string | undefined): number;
export declare function mcpToolMatchesQuery(item: {
    serverName: string;
    tool: {
        name: string;
        description?: string;
    };
}, query: string | undefined): boolean;
export declare function compareMcpToolSearchResults(left: {
    serverName: string;
    tool: {
        name: string;
        description?: string;
    };
}, right: {
    serverName: string;
    tool: {
        name: string;
        description?: string;
    };
}, query: string | undefined): number;
export declare function mcpToolRef(serverName: string, toolName: string): string;
export declare function listedMcpTool(capability: MaterializedMcpCapability, tool: {
    name: string;
    description?: string;
}): ListedMcpTool;
export declare function detailedMcpTool(capability: MaterializedMcpCapability, tool: {
    name: string;
    description?: string;
} & Record<string, unknown>): Omit<DetailedMcpTool, 'diagnostics'>;
export {};
