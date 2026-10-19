import type { PermissionCardAffordances } from '../domain/permission-card-affordances.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionRememberCode,
} from '../domain/types.js';
import { permissionDecisionOptions as scalarPermissionDecisionOptions } from './permission-decision-options.js';

/** Allow once, then Allow for future when the card can save, then Deny.
 *  Deny is the scalar cancel: a denial is never remembered. */
export function permissionCardDecisionOptions(
  affordances: PermissionCardAffordances,
): (PermissionApprovalDecisionMode | PermissionRememberCode)[] {
  if (!affordances.eligible) return [];
  return affordances.offered.includes('remember_allow_exact')
    ? ['allow_once', 'remember_allow_exact', 'cancel']
    : ['allow_once', 'cancel'];
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
): (PermissionApprovalDecisionMode | PermissionRememberCode)[] {
  return hasEligiblePermissionCardAffordances(request)
    ? permissionCardDecisionOptions(request.cardAffordances)
    : scalarPermissionDecisionOptions(request);
}

export function hasEligiblePermissionCardAffordances(
  request: PermissionApprovalRequest | undefined,
): request is PermissionApprovalRequest & {
  cardAffordances: PermissionCardAffordances & { eligible: true };
} {
  return request?.cardAffordances?.eligible === true;
}

export function formatPermissionCardPreTapLines(
  affordances: PermissionCardAffordances,
): string[] {
  return [...affordances.preTapLines];
}

export function formatPermissionCardReceipt(
  affordances: PermissionCardAffordances,
  code: PermissionRememberCode,
): string | undefined {
  return affordances.postTapLines[code];
}
