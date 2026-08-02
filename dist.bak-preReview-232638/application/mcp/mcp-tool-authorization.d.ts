import type { MaterializedMcpCapability } from './mcp-server-service.js';
export type ReviewedMaterializedMcpCapability = MaterializedMcpCapability & {
    reviewedToolNames: string[];
    reviewedToolPatterns?: string[];
    reviewedCapabilityIds?: string[];
};
export declare function isReviewedMcpToolAllowed(capability: ReviewedMaterializedMcpCapability, toolName: string): boolean;
export declare function reviewedToolNameAllowedBySourceScope(capability: MaterializedMcpCapability, fullToolName: string): boolean;
export declare function isSourceInventoryToolAllowed(capability: MaterializedMcpCapability, toolName: string): boolean;
