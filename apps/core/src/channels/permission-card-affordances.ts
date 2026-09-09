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
  const offers = (code: PermissionRememberCode) =>
    affordances.offered.includes(code);
  // A card always carries a way to say no: the remembered No when it is
  // offered, otherwise the scalar denial.
  const denial = offers('remember_deny_exact')
    ? ('remember_deny_exact' as const)
    : ('cancel' as const);
  if (affordances.protected) {
    return ['allow_once', denial];
  }
  const alternative = affordances.alternative;
  const showAlternative =
    alternative &&
    (!isPermissionRememberCode(alternative.code) || offers(alternative.code));
  return [
    ...(offers('remember_allow_exact')
      ? ['remember_allow_exact' as const]
      : []),
    ...(showAlternative ? [alternative.code] : []),
    'allow_once',
    denial,
  ];
}

function isPermissionRememberCode(
  code: PermissionApprovalDecisionMode | PermissionRememberCode,
): code is PermissionRememberCode {
  return code.startsWith('remember_');
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
  matchKind?: 'individual' | 'batch',
): (PermissionApprovalDecisionMode | PermissionRememberCode)[] {
  return hasEligiblePermissionCardAffordances(request)
    ? permissionCardDecisionOptions(request.cardAffordances)
    : scalarPermissionDecisionOptions(request, matchKind);
}

export function hasEligiblePermissionCardAffordances(
  request: PermissionApprovalRequest | undefined,
): request is PermissionApprovalRequest & {
  cardAffordances: PermissionCardAffordances & { eligible: true };
} {
  return request?.cardAffordances?.eligible === true;
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
  if (code === 'cancel' && affordances.eligible) return 'No';
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
