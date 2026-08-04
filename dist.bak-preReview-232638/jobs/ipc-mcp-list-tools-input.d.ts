export declare function mcpListToolsProxyInput(payload: Record<string, unknown>): {
    serverName?: string;
    query?: string;
    limit?: number;
    cursor?: string;
};
export declare function mcpDescribeToolProxyInput(payload: Record<string, unknown>): {
    serverName?: string;
    toolName?: string;
};
export declare function mcpCallToolProxyInput(payload: Record<string, unknown>): {
    serverName?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    argumentPayload?: unknown;
    missingFields: string[];
    invalidArguments: boolean;
};
