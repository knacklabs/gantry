import type { PermissionRiskCategory } from '../domain/types.js';
export declare const PERMISSION_CLASSIFIER_MAX_STRING_LENGTH = 16000;
export declare const PERMISSION_CLASSIFIER_MAX_TOOL_INPUT_CHARS = 16384;
export declare function permissionClassifierSystemPrompt(): string;
export declare function classifierUserPayload(input: {
    agentIdentity: {
        id: string;
        name?: string;
        folder?: string;
    };
    turnIntentSummary: string;
    canonicalToolName: string;
    toolInput: unknown;
    policyDecisionReason: string;
    recentlyApprovedExactToolShape?: boolean;
    recentlyDeniedExactToolShape?: boolean;
}): string;
export declare function redactPermissionClassifierToolInput(value: unknown): string;
export declare function serializePermissionClassifierToolInput(value: unknown): {
    value: string;
    truncated: boolean;
};
export type PermissionClassifierRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export declare function parsePermissionClassifierResponse(value: string): {
    ok: true;
    risk_level: PermissionClassifierRiskLevel;
    risk_category?: PermissionRiskCategory;
    reason: string;
} | {
    ok: false;
    failureCode: 'parse_failure' | 'validation_failure';
    error: Error;
};
