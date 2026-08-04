export declare const MAX_MCP_REMOTE_LIST_PAGES = 20;
export declare const MAX_MCP_REMOTE_TOOLS_PER_PAGE = 200;
export declare const MAX_MCP_REMOTE_TOOLS_TOTAL = 1000;
export declare const MAX_MCP_REMOTE_TOOL_METADATA_BYTES: number;
export type McpListedToolMetadata = {
    name: string;
    description?: string;
} & Record<string, unknown>;
export type McpToolListClient = {
    listTools(params?: {
        cursor?: string;
    }, options?: {
        timeout?: number;
        signal?: AbortSignal;
    }): Promise<{
        tools: McpListedToolMetadata[];
        nextCursor?: string;
    }>;
};
export type McpToolListPageResult = {
    tools: McpListedToolMetadata[];
    pageCount: number;
    truncated: boolean;
    nextCursor?: string;
};
export declare function fetchMcpToolListPages(input: {
    client: McpToolListClient;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<McpToolListPageResult>;
