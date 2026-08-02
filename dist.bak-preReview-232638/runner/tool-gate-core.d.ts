import { ToolExecutionClassifier, ToolExecutionPolicyService, type ToolPolicyDecision } from '../shared/tool-execution-policy-service.js';
import { type YoloModeSettings } from '../shared/yolo-mode-policy.js';
export type DeclarativeToolRule = {
    tool: string;
    action: 'block';
    reason: string;
    when?: {
        arg: string;
        matches: string;
    };
} | {
    tool: string;
    action: 'require_prior';
    prior: string;
    reason: string;
};
export interface DeclarativeToolRuleDenial {
    decision: 'declarative_tool_rule';
    reason: string;
    error: {
        category: 'permission' | 'validation';
        isRetryable: false;
        message: string;
    };
}
export interface ToolSuccessLedger {
    hasSuccess(toolName: string): boolean;
}
export declare class RunScopedToolSuccessLedger implements ToolSuccessLedger {
    #private;
    recordSuccess(toolName: string): void;
    hasSuccess(toolName: string): boolean;
}
export declare function evaluateDeclarativeToolRules(input: {
    toolName: string;
    toolInput: unknown;
    rules?: readonly DeclarativeToolRule[];
    successLedger?: ToolSuccessLedger;
}): DeclarativeToolRuleDenial | null;
export declare const LOCKED_ACCESS_PRESET_DENY_REASON = "capability not provisioned: this agent runs with a locked access preset and cannot request new tools, skills, MCP servers, or permissions. Provision the capability before the run.";
export declare function denyProtectedCapabilityToolUse(toolName: string, input: unknown): string | null;
export interface NeutralToolGateContext {
    isScheduledJob?: boolean;
    jobId?: string;
    threadId?: string;
    conversationId: string;
    yoloMode?: YoloModeSettings;
}
export interface NeutralPreCheckInput {
    toolName: string;
    toolInput: unknown;
    memoryBlock: string;
    isThirdPartyMcpTool?: boolean;
    yoloMode?: YoloModeSettings;
    toolRules?: readonly DeclarativeToolRule[];
    successLedger?: ToolSuccessLedger;
}
export declare function evaluateNeutralToolPreChecks(input: NeutralPreCheckInput): {
    decision: 'protected_capability' | 'memory_boundary' | 'yolo_denylist';
    reason: string;
} | DeclarativeToolRuleDenial | null;
export declare function evaluateNeutralToolPolicy(input: {
    classifier: ToolExecutionClassifier;
    policy: ToolExecutionPolicyService;
    toolName: string;
    toolInput: unknown;
    context: NeutralToolGateContext;
    allowedToolRules: readonly string[];
    autonomousAllowedToolRules?: readonly string[];
    capabilityRequestToolsHidden?: boolean;
}): ToolPolicyDecision;
