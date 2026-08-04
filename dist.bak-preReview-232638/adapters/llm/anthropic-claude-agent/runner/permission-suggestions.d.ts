import { type SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';
export interface PermissionSuggestionPlan {
    suggestions?: unknown[];
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}
export declare function synthesizePermissionSuggestions(toolName: string, options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
}): unknown[] | undefined;
export declare function synthesizePermissionSuggestionPlan(toolName: string, options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
}): PermissionSuggestionPlan;
export declare function scheduledPermissionSuggestions(toolName: string, sdkSuggestions: readonly unknown[] | undefined, options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
}): unknown[] | undefined;
export declare function livePermissionRulesForUpdates(updates: readonly unknown[] | undefined, plan: PermissionSuggestionPlan): string[];
export declare function scheduledPermissionSuggestionPlan(toolName: string, sdkSuggestions: readonly unknown[] | undefined, options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
}): PermissionSuggestionPlan;
export declare function readRunnerSkillActionCapabilities(): SemanticCapabilityDefinition[];
export declare function browserPermissionSuggestion(): unknown[];
export declare function permissionRequestToolName(toolName: string): string;
