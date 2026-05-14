import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalRuleValue,
  PermissionApprovalUpdate,
} from '../domain/types.js';
import { nowMs } from '../shared/time/datetime.js';
import { validatePersistentRequestPermissionRule } from '../shared/persistent-permission-rules.js';

export const TIMED_GRANT_DURATION_MS = 5 * 60 * 1000;
export const PERSISTENT_RULE_APPROVAL_MAX_RULES = 5;

export function persistentPermissionUpdates(
  request: PermissionApprovalRequest,
): PermissionApprovalUpdate[] {
  const candidates = (request.suggestions || []).filter(
    (update) =>
      (update.type === 'addRules' || update.type === 'replaceRules') &&
      update.behavior === 'allow' &&
      Array.isArray(update.rules) &&
      update.rules.length > 0,
  );
  if (candidates.length !== 1) return [];
  const rules = candidates[0].rules ?? [];
  if (rules.length > PERSISTENT_RULE_APPROVAL_MAX_RULES) return [];
  return rules.every((rule) => persistentRuleForSuggestion(rule))
    ? candidates
    : [];
}

export function persistentRules(request: PermissionApprovalRequest): string[] {
  const [update] = persistentPermissionUpdates(request);
  return (update?.rules || [])
    .map(persistentRuleForSuggestion)
    .filter((rule): rule is string => Boolean(rule));
}

export function firstPersistentRule(
  request: PermissionApprovalRequest,
): string | undefined {
  return persistentRules(request)[0];
}

function persistentRuleForSuggestion(
  rule: PermissionApprovalRuleValue,
): string | undefined {
  if (!rule?.toolName) return undefined;
  const persistentRule = rule.ruleContent
    ? `${rule.toolName}(${rule.ruleContent})`
    : rule.toolName;
  return validatePersistentRequestPermissionRule(persistentRule).ok
    ? persistentRule
    : undefined;
}

export function decisionForMode(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
  decidedBy?: string,
): PermissionApprovalDecision {
  if (mode === 'cancel') {
    return {
      approved: false,
      mode,
      decidedBy,
      reason: 'canceled',
      decisionClassification: 'user_reject',
    };
  }
  if (mode === 'allow_timed_grant') {
    return {
      approved: true,
      mode,
      decidedBy,
      reason: `timed grant for ${request.toolName} (${Math.round(TIMED_GRANT_DURATION_MS / 60000)} min)`,
      decisionClassification: 'user_temporary',
      timedGrantExpiresAtMs: nowMs() + TIMED_GRANT_DURATION_MS,
    };
  }
  if (mode === 'allow_persistent_rule') {
    const updates = persistentPermissionUpdates(request).map((update) => ({
      ...update,
      destination: 'session' as const,
    }));
    if (updates.length === 0) {
      return {
        approved: false,
        mode: 'cancel',
        decidedBy,
        reason: 'persistent rule unavailable',
        decisionClassification: 'user_reject',
      };
    }
    return {
      approved: true,
      mode,
      decidedBy,
      reason: 'persistent rule allowed',
      updatedPermissions: updates,
      decisionClassification: 'user_permanent',
    };
  }
  return {
    approved: true,
    mode,
    decidedBy,
    reason: 'allowed once',
    decisionClassification: 'user_temporary',
  };
}
