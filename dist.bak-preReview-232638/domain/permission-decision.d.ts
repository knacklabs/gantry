import type { PermissionApprovalDecision, PermissionApprovalDecisionMode, PermissionApprovalRequest, PermissionApprovalUpdate } from './types.js';
export declare const PERSISTENT_RULE_APPROVAL_MAX_RULES = 5;
export declare function persistentPermissionUpdates(request: PermissionApprovalRequest): PermissionApprovalUpdate[];
export declare function persistentRules(request: PermissionApprovalRequest): string[];
export declare function firstPersistentRule(request: PermissionApprovalRequest): string | undefined;
export declare function decisionForMode(request: PermissionApprovalRequest, mode: PermissionApprovalDecisionMode, decidedBy?: string): PermissionApprovalDecision;
