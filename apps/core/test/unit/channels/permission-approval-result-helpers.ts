import type {
  PermissionApprovalDecision,
  PermissionApprovalResult,
} from '@core/domain/types.js';

export function permissionDecisionResult(
  decision: PermissionApprovalDecision,
): PermissionApprovalResult {
  return { kind: 'decision', decision };
}

export function requirePermissionDecision(
  result: PermissionApprovalResult,
): PermissionApprovalDecision {
  if (result.kind === 'delivery_failure') {
    throw new Error(`Expected a decision result: ${result.userMessage}`);
  }
  return result.decision;
}
