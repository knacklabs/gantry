import { type AdminMcpToolName } from './admin-mcp-tools.js';
export interface RequestableAdminToolAccess {
    tool: string;
    toolId: string;
    requestPermission: string;
    note?: string;
}
export interface AgentToolAccessView {
    configuredTools: string[];
    defaultTools: string[];
    availableButGatedTools: string[];
    requestableAdminTools: RequestableAdminToolAccess[];
    source: string;
}
export interface JobToolAccessView {
    inheritedAgentTools: string[];
    effectiveAllowedTools: string[];
    projectedRuntimeTools: string[];
    source: string;
}
export declare const PERMISSION_GATED_NATIVE_TOOLS: readonly ["RunCommand", "FileEdit", "FileWrite"];
export declare const BROWSER_TOOL_NAME = "Browser";
export declare const BROWSER_REQUEST_PERMISSION_ARGS = "target.kind=capability target.id=browser.use temporaryOnly=false reason=\"<why this agent needs Browser>\"";
export declare const BROWSER_REQUESTABLE_NOTE = "Browser approval exposes Gantry-owned browser_* tools. Status is read-only; action calls launch the host-derived profile lazily.";
export declare function buildRequestableAdminToolAccess(enabledAdminTools: ReadonlySet<AdminMcpToolName | string>): RequestableAdminToolAccess[];
export declare function buildRequestableBrowserToolAccess(input: {
    configuredTools?: readonly string[];
    externalMcpAllowedTools?: readonly string[];
}): RequestableAdminToolAccess[];
export declare function buildAgentToolAccessView(input: {
    configuredTools?: readonly string[];
    defaultTools?: readonly string[];
    availableButGatedTools?: readonly string[];
    requestableAdminTools?: readonly RequestableAdminToolAccess[];
    source: string;
}): AgentToolAccessView;
export declare function buildConfiguredAgentToolAccess(configuredTools: string[], requestableAdminTools: readonly RequestableAdminToolAccess[]): AgentToolAccessView;
export declare function buildJobToolAccessView(input: {
    inheritedAgentTools?: readonly string[];
    effectiveAllowedTools?: readonly string[];
    projectedRuntimeTools?: readonly string[];
    source?: string;
}): JobToolAccessView;
export declare function formatAgentToolAccess(view: AgentToolAccessView): string;
export declare function formatJobToolAccess(view: JobToolAccessView | undefined): string;
export declare function compactToolList(values: readonly string[] | undefined, maxLength?: number): string;
