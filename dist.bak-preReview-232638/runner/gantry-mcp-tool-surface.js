import { ADMIN_MCP_TOOL_NAMES, ALL_GANTRY_MCP_TOOL_NAMES, ASYNC_TASK_GANTRY_MCP_TOOL_NAMES, AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES, BASELINE_GANTRY_MCP_TOOL_NAMES, DEFAULT_GANTRY_MCP_TOOL_NAMES, DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES, GATED_GANTRY_MCP_TOOL_NAMES, OPTIONAL_GANTRY_MCP_TOOL_NAMES, REVIEWED_GANTRY_MCP_TOOL_NAMES, } from '../shared/admin-mcp-tools.js';
import { selectedMemoryIpcActionsFromToolRules, } from '../shared/memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
// Authority-changing Gantry tools let an agent request new install/setup/access
// authority for itself. In the fixed-image worker product mode they are hidden
// from user-facing live agents and scheduled jobs: workers never install tools,
// skills, MCP servers, or dependencies during a run. Admin tools are tracked
// separately in ADMIN_MCP_TOOL_NAMES. The canonical constants live in shared;
// these re-exports preserve the runner's public tool-surface API.
export { ALL_GANTRY_MCP_TOOL_NAMES, ASYNC_TASK_GANTRY_MCP_TOOL_NAMES, AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES, BASELINE_GANTRY_MCP_TOOL_NAMES, DEFAULT_GANTRY_MCP_TOOL_NAMES, DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES, GATED_GANTRY_MCP_TOOL_NAMES, OPTIONAL_GANTRY_MCP_TOOL_NAMES, REVIEWED_GANTRY_MCP_TOOL_NAMES, };
const REVIEWER_MEMORY_REVIEW_GANTRY_MCP_TOOL_NAMES = [
    'memory_review_pending',
    'memory_review_decision',
];
export const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES = [
    ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
    ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
    ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
    ...OPTIONAL_GANTRY_MCP_TOOL_NAMES,
    ...REVIEWED_GANTRY_MCP_TOOL_NAMES,
];
const AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET = new Set(AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES);
const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET = new Set(NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES);
const ADMIN_MCP_TOOL_NAME_SET = new Set(ADMIN_MCP_TOOL_NAMES);
export function isAuthorityChangingGantryMcpToolName(value) {
    return AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET.has(value);
}
export function isNoPermissionHiddenGantryMcpToolName(value) {
    return NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(value);
}
const ALL_GANTRY_MCP_TOOL_NAME_SET = new Set(ALL_GANTRY_MCP_TOOL_NAMES);
export function gantryMcpFullToolName(toolName) {
    return `mcp__gantry__${toolName}`;
}
export function gantryMcpToolNameFromFullName(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('mcp__gantry__'))
        return null;
    const toolName = trimmed.slice('mcp__gantry__'.length);
    return ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName) ? toolName : null;
}
export function selectedGantryMcpToolNames(configuredTools, options = {}) {
    const names = new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
    if (options.asyncTaskToolsEnabled && !options.excludeAuthorityTools) {
        for (const toolName of ASYNC_TASK_GANTRY_MCP_TOOL_NAMES)
            names.add(toolName);
        if (configuredTools.includes('AgentDelegation')) {
            for (const toolName of DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES)
                names.add(toolName);
        }
    }
    if (isBrowserSelected(configuredTools)) {
        for (const toolName of GATED_GANTRY_MCP_TOOL_NAMES)
            names.add(toolName);
    }
    if (options.memoryReviewerIsControlApprover) {
        for (const toolName of REVIEWER_MEMORY_REVIEW_GANTRY_MCP_TOOL_NAMES) {
            names.add(toolName);
        }
    }
    for (const configuredTool of configuredTools) {
        const name = gantryMcpToolNameFromFullName(configuredTool);
        if (name &&
            (options.asyncTaskToolsEnabled ||
                ![
                    ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
                    ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
                ].includes(name)) &&
            !GATED_GANTRY_MCP_TOOL_NAMES.includes(name)) {
            names.add(name);
        }
    }
    if (options.excludeAuthorityTools) {
        for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
            names.delete(toolName);
        }
        for (const toolName of ADMIN_MCP_TOOL_NAMES) {
            names.delete(toolName);
        }
    }
    return [...names].sort();
}
function isBrowserSelected(configuredTools) {
    return configuredTools.some(isCanonicalBrowserCapabilityRule);
}
export function selectedGantryMcpFullToolNames(configuredTools, options = {}) {
    return selectedGantryMcpToolNames(configuredTools, options).map(gantryMcpFullToolName);
}
// Locked agents start from the default surface minus every authority-changing
// and admin tool. This is the fail-closed base: an unset or corrupt env can
// never restore authority tools for a locked agent.
function lockedDefaultGantryMcpToolNames() {
    const names = new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
        names.delete(toolName);
    }
    for (const toolName of ADMIN_MCP_TOOL_NAMES) {
        names.delete(toolName);
    }
    return names;
}
export function parseEnabledGantryMcpToolNames(raw, options = {}) {
    // For locked agents a malformed/unset env must fail closed to the locked
    // base set, never to the full default set that still carries authority tools.
    const fallback = () => options.lockedPreset
        ? lockedDefaultGantryMcpToolNames()
        : new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
    const base = () => options.lockedPreset
        ? lockedDefaultGantryMcpToolNames()
        : new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
    if (!raw?.trim()) {
        return fallback();
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return fallback();
        }
        const enabled = base();
        for (const item of parsed) {
            const toolName = typeof item === 'string' ? item.trim() : '';
            if (!ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName))
                continue;
            if (options.lockedPreset &&
                (NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(toolName) ||
                    ADMIN_MCP_TOOL_NAME_SET.has(toolName))) {
                continue;
            }
            enabled.add(toolName);
        }
        return enabled;
    }
    catch {
        return fallback();
    }
}
export function selectedMemoryIpcActions(configuredTools, options = {}) {
    return selectedMemoryIpcActionsFromToolRules(configuredTools, options);
}
