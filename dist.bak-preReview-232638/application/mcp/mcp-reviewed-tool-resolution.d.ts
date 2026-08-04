import { type ReviewedMaterializedMcpCapability } from './mcp-tool-authorization.js';
import type { McpToolAuditResultClass } from './mcp-tool-audit.js';
export declare function resolveReviewedMcpTool(input: {
    capabilities: ReviewedMaterializedMcpCapability[];
    serverName: string;
    toolName: string;
    finalizeDenied: (resultClass: McpToolAuditResultClass, extra?: Record<string, unknown>) => Promise<unknown>;
}): Promise<{
    capability: ReviewedMaterializedMcpCapability;
    selectedToolRule: string;
    selectedCapability: Pick<ReviewedMaterializedMcpCapability, 'name' | 'serverId' | 'bindingId' | 'sourceRevision'>;
}>;
