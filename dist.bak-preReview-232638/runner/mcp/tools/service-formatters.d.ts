export declare function formatMcpApprovalResponse(data: unknown, message: string): string;
export declare function formatMcpListToolsResponse(data: unknown, options?: {
    includeReviewGuidance?: boolean;
}): string;
export declare function formatMcpSearchToolsResponse(data: unknown, options?: {
    includeReviewGuidance?: boolean;
}): string;
export declare function formatMcpDescribeToolResponse(data: unknown): string;
export declare function formatMcpCallToolResponse(data: unknown): string;
export declare function formatSkillProposalResponse(data: unknown, message: string, options?: {
    deploymentMode?: 'workstation' | 'fleet';
}): string;
