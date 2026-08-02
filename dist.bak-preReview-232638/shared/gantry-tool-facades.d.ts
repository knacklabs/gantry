export declare const RUN_COMMAND_TOOL_NAME = "RunCommand";
export declare const GANTRY_FACADE_EXACT_TOOL_NAMES: readonly ["WebSearch", "WebRead", "FileSearch", "FileRead", "FileEdit", "FileWrite", "AgentDelegation"];
export type GantryFacadeExactToolName = (typeof GANTRY_FACADE_EXACT_TOOL_NAMES)[number];
export declare function canonicalGantryToolRuleName(toolName: string, context?: {
    callableAgentToolNames?: ReadonlySet<string>;
}): string;
export declare const PROVIDER_NATIVE_TOOL_REJECTION_REASON = "Provider-native SDK tools are execution-harness projections and cannot be persisted as Gantry tool rules; select a Gantry capability such as Browser, a Gantry file/web tool, a semantic capability, an exact Gantry admin MCP tool, or a scoped RunCommand(...) fallback.";
export interface GantryHarnessToolProjection {
    exactTools: Partial<Record<GantryFacadeExactToolName, readonly string[]>>;
    runCommandToolName?: string;
}
export declare const DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION: GantryHarnessToolProjection;
export declare const GANTRY_FACADE_INPUT_SCHEMAS: Record<GantryFacadeExactToolName, {
    format: 'json-schema';
    schema: Record<string, unknown>;
}>;
export declare function providerNativeToolReplacement(toolName: string): string;
export declare function providerNativeToolRejectionReason(toolName: string): string;
export declare function isProviderNativeExactToolRule(value: string): boolean;
export declare function isGantryFacadeExactToolRule(value: string): boolean;
export declare function isGantryFacadeExactToolName(value: string): value is GantryFacadeExactToolName;
export declare function isRunCommandToolRule(value: string): boolean;
export declare function publicGantryToolNameForSdkTool(toolName: string): string;
export declare function publicCapabilityAllowedToolRules(tools: readonly string[]): string[];
export declare function sdkToolsForGantryFacadeTool(toolName: string): readonly string[];
export declare function projectGantryToolRuleForHarness(toolRule: string, projection: GantryHarnessToolProjection): string[];
export declare function validateGantryFacadeToolInput(toolName: GantryFacadeExactToolName, input: unknown): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
