export declare function reviewedMcpToolPatterns(input: {
    allowedToolPatterns?: readonly string[];
    autoApproveToolPatterns?: readonly string[];
}): string[];
export declare function normalizeMcpToolScope(input: {
    serverName: string;
    requested: readonly string[] | undefined;
    definitionPatterns: readonly string[];
}): string[];
export declare function intersectMcpToolRulesWithSourceScopes(toolRules: readonly string[], sources: readonly {
    name: string;
    allowedToolPatterns: readonly string[];
}[]): string[];
export declare function mcpToolNameAllowedBySourceScope(input: {
    serverName: string;
    fullToolName: string;
    allowedToolPatterns: readonly string[];
}): boolean;
export declare function mcpToolPatternCovers(pattern: string, candidate: string): boolean;
