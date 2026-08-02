import { mcpToolNameAllowedBySourceScope, mcpToolPatternCovers, } from '../../shared/mcp-tool-scope.js';
export function isReviewedMcpToolAllowed(capability, toolName) {
    const fullToolName = toolName.startsWith('mcp__')
        ? toolName
        : `mcp__${capability.name}__${toolName}`;
    if (!reviewedToolNameAllowedBySourceScope(capability, fullToolName)) {
        return false;
    }
    if (capability.reviewedToolNames.includes(fullToolName))
        return true;
    return (capability.reviewedToolPatterns ?? []).some((pattern) => mcpToolPatternCovers(pattern, fullToolName));
}
export function reviewedToolNameAllowedBySourceScope(capability, fullToolName) {
    return mcpToolNameAllowedBySourceScope({
        serverName: capability.name,
        fullToolName,
        allowedToolPatterns: capability.allowedToolPatterns,
    });
}
export function isSourceInventoryToolAllowed(capability, toolName) {
    const patterns = capability.allowedToolPatterns.length > 0
        ? capability.allowedToolPatterns
        : capability.allowedToolNames.map((name) => name.replace(`mcp__${capability.name}__`, ''));
    if (patterns.length === 0)
        return true;
    return patterns.some((pattern) => mcpToolPatternCovers(pattern, toolName));
}
