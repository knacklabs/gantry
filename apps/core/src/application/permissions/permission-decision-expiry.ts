import type { PermissionApprovalDecision } from '../../domain/types.js';

export function permissionDecisionExpiresAt(
  decision: PermissionApprovalDecision,
  now: string,
): string | undefined {
  if (!decision.approved) return undefined;
  if (decision.mode === 'allow_once') return now;
  if (
    decision.mode === 'allow_timed_grant' &&
    typeof decision.timedGrantExpiresAtMs === 'number' &&
    Number.isFinite(decision.timedGrantExpiresAtMs)
  ) {
    return new Date(decision.timedGrantExpiresAtMs).toISOString();
  }
  return undefined;
}
