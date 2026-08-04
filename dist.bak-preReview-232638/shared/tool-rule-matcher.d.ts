export { normalizeRuntimeOwnedBashCommandForMatching } from './tool-rule-runtime-command.js';
export interface ToolRuleValidationResult {
    ok: boolean;
    reason?: string;
}
export interface ToolRuleEvaluationResult {
    allowed: boolean;
    matchedRule?: string;
    matchedRules?: string[];
    closestRule?: {
        rule: string;
        reason: string;
    };
    reason?: string;
}
export declare function normalizeToolRules(rules: readonly unknown[] | undefined): string[];
export declare function validateAutonomousToolRule(rule: string): ToolRuleValidationResult;
export declare function validateAutonomousToolRules(rules: readonly string[]): ToolRuleValidationResult;
export declare function toolRuleMatches(rule: string, toolName: string): boolean;
export declare function anyToolRuleMatches(rules: readonly string[], toolName: string): boolean;
export declare function toolRuleCoversRule(allowedRule: string, candidateRule: string): boolean;
export declare function evaluateAutonomousToolUse(input: {
    rules: readonly string[];
    toolName: string;
    toolInput?: unknown;
}): ToolRuleEvaluationResult;
