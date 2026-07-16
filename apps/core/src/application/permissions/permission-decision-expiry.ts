import type { PermissionApprovalDecision } from '../../domain/types.js';

export function permissionDecisionExpiresAt(
  decision: PermissionApprovalDecision,
  now: string,
): string | undefined {
  if (!decision.approved) return undefined;
  if (decision.mode === 'allow_once') return now;
  return undefined;
}
