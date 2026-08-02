const EXACT_EXTERNAL_MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.-]+$/;
const PATTERN_EXTERNAL_MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.-]+\*?$/;
// Reviewed full-name MCP tool patterns (exact or mcp__server__prefix*) selected
// via mcp_pattern capability bindings. These are the single action authority;
// inventory stays discovery-only.
export function reviewedExternalMcpToolPatternsFromRuntimeAccess(runtimeAccess) {
    const out = new Set();
    for (const access of runtimeAccess ?? []) {
        if (access.sourceType !== 'mcp_server')
            continue;
        for (const tool of access.allowedTools) {
            const trimmed = tool.trim();
            const match = PATTERN_EXTERNAL_MCP_TOOL_RE.exec(trimmed);
            if (!match?.[1] || match[1] === 'gantry')
                continue;
            out.add(trimmed);
        }
    }
    return [...out];
}
export function reviewedExternalMcpToolNamesFromRuntimeAccess(runtimeAccess, options = {}) {
    const serverNames = options.serverNames
        ? new Set(options.serverNames.map((name) => name.trim()).filter(Boolean))
        : undefined;
    const out = new Set();
    for (const access of runtimeAccess ?? []) {
        if (access.sourceType !== 'mcp_server')
            continue;
        for (const tool of access.allowedTools) {
            const trimmed = tool.trim();
            const match = EXACT_EXTERNAL_MCP_TOOL_RE.exec(trimmed);
            if (!match?.[1])
                continue;
            if (trimmed.startsWith('mcp__gantry__'))
                continue;
            if (serverNames && !serverNames.has(match[1]))
                continue;
            out.add(trimmed);
        }
    }
    return [...out];
}
