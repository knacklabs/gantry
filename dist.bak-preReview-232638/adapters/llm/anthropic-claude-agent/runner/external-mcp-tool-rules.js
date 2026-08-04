import { isPublicExternalMcpToolRule } from '../agent-capabilities.js';
export function readExternalMcpAllowedTools() {
    return readExternalMcpToolRules('GANTRY_MCP_ALLOWED_TOOLS_JSON');
}
export function readExternalMcpAlwaysAllowedTools() {
    return readExternalMcpToolRules('GANTRY_MCP_ALWAYS_ALLOWED_TOOLS_JSON');
}
function readExternalMcpToolRules(envKey) {
    const raw = process.env[envKey]?.trim();
    if (!raw)
        return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((entry) => typeof entry === 'string' && isPublicExternalMcpToolRule(entry));
}
