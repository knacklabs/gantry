export { GANTRY_FACADE_EXACT_TOOL_NAMES, GANTRY_FACADE_INPUT_SCHEMAS, DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION, type GantryFacadeExactToolName, type GantryHarnessToolProjection, isGantryFacadeExactToolName, isGantryFacadeExactToolRule, isProviderNativeExactToolRule, isRunCommandToolRule, projectGantryToolRuleForHarness, publicCapabilityAllowedToolRules, providerNativeToolRejectionReason, providerNativeToolReplacement, PROVIDER_NATIVE_TOOL_REJECTION_REASON, publicGantryToolNameForSdkTool, RUN_COMMAND_TOOL_NAME, sdkToolsForGantryFacadeTool, validateGantryFacadeToolInput, } from './gantry-tool-facades.js';
export declare const SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME = "SandboxNetworkAccess";
export declare const PROJECTED_BROWSER_MCP_TOOL_NAMES: readonly ["mcp__gantry__browser_status", "mcp__gantry__browser_open", "mcp__gantry__browser_inspect", "mcp__gantry__browser_act", "mcp__gantry__browser_close"];
export declare const BROWSER_ACTION_MCP_RULE_REJECTION_REASON = "Host-private browser backend tools cannot be persisted as agent tool rules; use the canonical Browser tool capability instead.";
export declare const BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON = "Gantry browser tools are runtime projections, not durable capabilities; persist the canonical Browser tool capability instead.";
export declare const BASH_SCOPE_REJECTION_REASON = "Persistent RunCommand scope is too broad; include a literal argv prefix such as RunCommand(npm test *).";
export declare const SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON = "SDK sandbox network prompts are internal defense-in-depth callbacks and cannot be persisted as agent tool rules; approve the underlying semantic capability, canonical Browser grant, exact admin MCP tool, MCP server binding, or scoped RunCommand fallback instead.";
export declare function parseReadableScopedToolRule(value: string): {
    toolName: string;
    scope: string;
} | null;
export declare function isBrowserActionMcpToolRule(value: string): boolean;
export declare function isHostPrivateBrowserMcpServerName(value: string): boolean;
export declare function isProjectedBrowserMcpToolRule(value: string): boolean;
export declare function isReviewedMcpPatternRule(value: string): boolean;
export declare function isThirdPartyMcpToolRule(value: string): boolean;
export declare function isKnownProjectedBrowserMcpToolName(value: string): boolean;
export declare function isCanonicalBrowserCapabilityRule(value: string): boolean;
export declare function isSdkSandboxNetworkAccessToolName(value: string): boolean;
export declare function isSdkSandboxNetworkAccessToolRule(value: string): boolean;
export declare function persistentPermissionToolId(appId: string, allowedRule: string): string;
export declare function displayToolReference(input: {
    toolId: unknown;
    tool?: {
        name?: string | null;
    } | null;
}): string;
export declare function validateReadableAgentToolRule(value: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function validatePersistentBashScope(scope: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function hasBashShellControlSyntax(value: string): boolean;
