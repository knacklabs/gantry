import { ADMIN_MCP_TOOL_NAMES, adminMcpToolFullName, adminMcpToolIdForFullName, } from './admin-mcp-tools.js';
import { PROJECTED_BROWSER_MCP_TOOL_NAMES, isCanonicalBrowserCapabilityRule, parseReadableScopedToolRule, RUN_COMMAND_TOOL_NAME, sdkToolsForGantryFacadeTool, } from './agent-tool-references.js';
import { canonicalizeGeneratedRuntimeSkillPaths, generatedRuntimeSkillPathDisplay, } from './generated-runtime-paths.js';
export const PERMISSION_GATED_NATIVE_TOOLS = [
    'RunCommand',
    'FileEdit',
    'FileWrite',
];
export const BROWSER_TOOL_NAME = 'Browser';
export const BROWSER_REQUEST_PERMISSION_ARGS = 'target.kind=capability target.id=browser.use temporaryOnly=false reason="<why this agent needs Browser>"';
export const BROWSER_REQUESTABLE_NOTE = 'Browser approval exposes Gantry-owned browser_* tools. Status is read-only; action calls launch the host-derived profile lazily.';
export function buildRequestableAdminToolAccess(enabledAdminTools) {
    return ADMIN_MCP_TOOL_NAMES.filter((toolName) => !enabledAdminTools.has(toolName)).map((toolName) => {
        const fullName = adminMcpToolFullName(toolName);
        return {
            tool: fullName,
            toolId: adminMcpToolIdForFullName(fullName),
            requestPermission: `target.kind=tool target.name="${fullName}" temporaryOnly=false reason="<why this agent needs ${toolName}>"`,
        };
    });
}
export function buildRequestableBrowserToolAccess(input) {
    void input.externalMcpAllowedTools;
    if (isBrowserCapabilitySelected(input.configuredTools ?? [])) {
        return [];
    }
    return [
        {
            tool: BROWSER_TOOL_NAME,
            toolId: `tool:${BROWSER_TOOL_NAME}`,
            requestPermission: BROWSER_REQUEST_PERMISSION_ARGS,
            note: BROWSER_REQUESTABLE_NOTE,
        },
    ];
}
export function buildAgentToolAccessView(input) {
    return {
        configuredTools: uniqueDisplayRules(input.configuredTools ?? []),
        defaultTools: uniqueStrings(input.defaultTools ?? []),
        availableButGatedTools: uniqueStrings(input.availableButGatedTools ?? []),
        requestableAdminTools: uniqueRequestableAdminTools(input.requestableAdminTools ?? []),
        source: input.source,
    };
}
export function buildConfiguredAgentToolAccess(configuredTools, requestableAdminTools) {
    return buildAgentToolAccessView({
        configuredTools,
        defaultTools: [],
        availableButGatedTools: PERMISSION_GATED_NATIVE_TOOLS.filter((toolName) => !configuredTools.some((configured) => configured === toolName || configured.startsWith(`${toolName}(`))),
        requestableAdminTools,
        source: 'Postgres agent_tool_bindings projected from settings.yaml',
    });
}
export function buildJobToolAccessView(input) {
    const effectiveAllowedTools = uniqueStrings(input.effectiveAllowedTools ?? []);
    return {
        inheritedAgentTools: uniqueDisplayRules(input.inheritedAgentTools ?? []),
        effectiveAllowedTools: uniqueDisplayRules(effectiveAllowedTools),
        projectedRuntimeTools: uniqueStrings(input.projectedRuntimeTools ??
            projectedRuntimeToolsForRules(effectiveAllowedTools)),
        source: input.source ?? 'inherited target agent capabilities',
    };
}
export function formatAgentToolAccess(view) {
    return [
        'Tool Access:',
        `  Source: ${view.source}`,
        `  Configured tools: ${formatList(view.configuredTools)}`,
        `  Default tools: ${formatList(view.defaultTools)}`,
        `  Available but gated: ${formatList(view.availableButGatedTools)}`,
        `  Requestable admin tools: ${formatList(view.requestableAdminTools.map((tool) => tool.tool))}`,
    ].join('\n');
}
export function formatJobToolAccess(view) {
    if (!view)
        return 'Tool access: (none)';
    return `Tool access: inherited ${formatList(view.inheritedAgentTools)}; effective ${formatList(view.effectiveAllowedTools)}; projected ${formatList(view.projectedRuntimeTools)}`;
}
export function compactToolList(values, maxLength = 36) {
    const label = uniqueStrings(values ?? []).join(', ');
    if (!label)
        return '-';
    return label.length > maxLength
        ? `${label.slice(0, maxLength - 3)}...`
        : label;
}
function formatList(values) {
    return values.length > 0 ? values.join(', ') : '(none)';
}
function uniqueStrings(values) {
    const out = new Set();
    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed)
            out.add(trimmed);
    }
    return [...out];
}
function uniqueDisplayRules(values) {
    return uniqueStrings(values.map(formatToolRuleForUser));
}
function formatToolRuleForUser(value) {
    const generatedSkillPath = generatedRuntimeSkillPathDisplay(value);
    if (!generatedSkillPath)
        return value;
    const canonical = canonicalizeGeneratedRuntimeSkillPaths(value);
    const scoped = parseReadableScopedToolRule(canonical);
    if (scoped?.toolName === RUN_COMMAND_TOOL_NAME &&
        /^chmod\s+\+x\s+/.test(scoped.scope)) {
        return `Generated skill action setup (${generatedSkillPath})`;
    }
    return `Generated skill action (${generatedSkillPath})`;
}
function uniqueRequestableAdminTools(values) {
    const out = new Map();
    for (const value of values) {
        if (!value.tool.trim())
            continue;
        out.set(value.tool, value);
    }
    return [...out.values()];
}
function isBrowserCapabilitySelected(configuredTools) {
    return configuredTools.some(isCanonicalBrowserCapabilityRule);
}
function projectedRuntimeToolsForRules(rules) {
    const projected = new Set();
    if (isBrowserCapabilitySelected(rules)) {
        for (const toolName of PROJECTED_BROWSER_MCP_TOOL_NAMES) {
            projected.add(toolName);
        }
    }
    for (const rule of rules) {
        const scoped = parseReadableScopedToolRule(rule);
        if (scoped?.toolName === RUN_COMMAND_TOOL_NAME)
            projected.add('Bash');
        for (const toolName of sdkToolsForGantryFacadeTool(rule)) {
            projected.add(toolName);
        }
    }
    return [...projected];
}
