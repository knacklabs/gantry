import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../domain/types.js';
export declare function permissionDecisionName(decision: PermissionApprovalDecision): 'allowed' | 'cancelled' | 'denied';
export declare function permissionDecisionEventType(decision: PermissionApprovalDecision): "permission.allowed" | "permission.denied" | "permission.cancelled";
export declare function permissionTelemetryContext(request: PermissionApprovalRequest, extra: Record<string, unknown>): Record<string, unknown>;
