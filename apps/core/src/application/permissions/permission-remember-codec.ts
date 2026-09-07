import {
  HumanDecisionOutcome,
  HumanDecisionScope,
  type PermissionRememberResolution,
} from '../../domain/human-decision.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionRememberCode,
} from '../../domain/types.js';

export const PERMISSION_REMEMBER_CODES = [
  'remember_allow_exact',
  'remember_allow_kind',
  'remember_allow_place',
  'remember_deny_exact',
] as const satisfies readonly PermissionRememberCode[];

export type DecodedPermissionDecisionCode = {
  mode: PermissionApprovalDecisionMode;
  remember?: PermissionRememberResolution;
};

export function decodePermissionDecisionCode(
  value: string,
): DecodedPermissionDecisionCode | null {
  if (
    value === 'allow_once' ||
    value === 'allow_persistent_rule' ||
    value === 'cancel'
  ) {
    return { mode: value };
  }
  if (value === 'remember_deny_exact') {
    return {
      mode: 'cancel',
      remember: {
        kind: 'remember',
        outcome: HumanDecisionOutcome.Deny,
        scope: HumanDecisionScope.Exact,
      },
    };
  }
  const scope =
    value === 'remember_allow_exact'
      ? HumanDecisionScope.Exact
      : value === 'remember_allow_kind'
        ? HumanDecisionScope.Kind
        : value === 'remember_allow_place'
          ? HumanDecisionScope.Place
          : null;
  return scope
    ? {
        mode: 'allow_once',
        remember: {
          kind: 'remember',
          outcome: HumanDecisionOutcome.Allow,
          scope,
        },
      }
    : null;
}

export function encodePermissionRememberCode(
  resolution: PermissionRememberResolution,
): PermissionRememberCode | null {
  if (resolution.outcome === HumanDecisionOutcome.Deny) {
    return resolution.scope === HumanDecisionScope.Exact
      ? 'remember_deny_exact'
      : null;
  }
  if (resolution.outcome !== HumanDecisionOutcome.Allow) return null;
  if (resolution.scope === HumanDecisionScope.Exact)
    return 'remember_allow_exact';
  if (resolution.scope === HumanDecisionScope.Kind)
    return 'remember_allow_kind';
  return resolution.scope === HumanDecisionScope.Place
    ? 'remember_allow_place'
    : null;
}
