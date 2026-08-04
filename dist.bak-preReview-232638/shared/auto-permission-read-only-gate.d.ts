export interface McpReadBinding {
    capabilityId: string;
    toolPattern: string;
}
export interface AutoPermissionReadOnlyGateInput {
    canonicalToolName: string;
    toolInput: unknown;
    approvedCapabilityIds: readonly string[];
    workspaceRoot?: string;
    reviewedMcpReadBindings?: readonly McpReadBinding[];
}
export interface AutoPermissionReadOnlyGateResult {
    allowed: boolean;
    reason: string;
}
export declare function evaluateAutoPermissionReadOnlyGate(input: AutoPermissionReadOnlyGateInput): AutoPermissionReadOnlyGateResult;
