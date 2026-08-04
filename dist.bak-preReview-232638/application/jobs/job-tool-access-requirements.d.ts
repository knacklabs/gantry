export interface ToolAccessRequirementPreflightResult {
    toolAccessRequirements: string[];
    missingTools: string[];
}
export declare function normalizeToolAccessRequirements(values: readonly unknown[], fieldName?: string): string[];
export declare function normalizeRequiredMcpServers(values: readonly unknown[], fieldName?: string): string[];
export declare function evaluateToolAccessRequirements(input: {
    toolAccessRequirements?: readonly string[];
    effectiveAllowedTools: readonly string[];
}): ToolAccessRequirementPreflightResult;
export declare function toolAccessRequirementRecoveryAction(toolName: string): string;
export declare function missingToolAccessRequirementError(toolName: string): string;
