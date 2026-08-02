export interface PermissionRuleLike {
    toolName?: unknown;
    ruleContent?: unknown;
}
export interface PermissionUpdateLike {
    type?: unknown;
    behavior?: unknown;
    rules?: unknown;
}
export declare function permissionUpdateAllowedToolRules(updates: readonly unknown[] | undefined): string[];
export declare function persistentPermissionUpdates(decision: {
    approved?: boolean;
    mode?: string | null;
    decisionClassification?: string | null;
    updatedPermissions?: readonly unknown[];
}): readonly unknown[] | undefined;
