import type { McpToolAuditResultClass } from '../../application/mcp/mcp-tool-audit.js';
import type { McpCompatibleToolError } from '../../runtime/core-tools/contracts.js';
export type ThirdPartyMcpToolActivity = {
    serverName: string;
    toolName: string;
    toolInput: unknown;
    outcome: 'attempt' | 'success' | 'failure';
    latencyMs: number;
    result?: unknown;
    error?: unknown;
    resultClass?: McpToolAuditResultClass;
    structuredError?: McpCompatibleToolError;
};
export declare function isSuccessfulMcpActivity(activity: ThirdPartyMcpToolActivity): boolean;
export declare function isMcpErrorResult(result: unknown): boolean;
