export declare const MAX_MCP_TOOL_RESULT_CHARS = 100000;
export declare function boundMcpToolResultForReturn(result: unknown): unknown;
export declare function serializeMcpToolResult(result: unknown, maxChars?: number): {
    text: string;
    truncated: boolean;
};
