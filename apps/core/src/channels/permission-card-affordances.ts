import type { PermissionCardAffordances } from '../domain/permission-card-affordances.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionRememberCode,
} from '../domain/types.js';
import { permissionDecisionOptions as scalarPermissionDecisionOptions } from './permission-decision-options.js';

export function permissionCardDecisionOptions(
  affordances: PermissionCardAffordances,
): (PermissionApprovalDecisionMode | PermissionRememberCode)[] {
  if (!affordances.eligible) return [];
  if (affordances.protected) return ['allow_once', 'remember_deny_exact'];
  return [
    'remember_allow_exact',
    ...(affordances.alternative ? [affordances.alternative.code] : []),
    'allow_once',
    'remember_deny_exact',
  ];
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
  matchKind?: 'individual' | 'batch',
): (PermissionApprovalDecisionMode | PermissionRememberCode)[] {
  return request.cardAffordances?.eligible
    ? permissionCardDecisionOptions(request.cardAffordances)
    : scalarPermissionDecisionOptions(request, matchKind);
}

export function permissionCardButtonLabel(
  code: PermissionApprovalDecisionMode | PermissionRememberCode,
  affordances: PermissionCardAffordances,
): string | undefined {
  if (code === affordances.alternative?.code)
    return affordances.alternative.label;
  if (code === 'remember_allow_exact') return 'Allow';
  if (code === 'allow_once')
    return affordances.protected ? 'Allow once' : 'Just this once';
  if (code === 'remember_deny_exact') return 'No';
  return undefined;
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
