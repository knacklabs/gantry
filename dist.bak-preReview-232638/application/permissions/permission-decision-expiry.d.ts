import type { PermissionApprovalDecision } from '../../domain/types.js';
export declare function permissionDecisionExpiresAt(decision: PermissionApprovalDecision, now: string): string | undefined;
