import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalRuleValue,
  PermissionApprovalUpdate,
} from '../domain/types.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { nowMs } from '../shared/time/datetime.js';
import { validateDurableAccessRule } from '../shared/durable-access-policy.js';
import { permissionUpdateAllowedToolRules } from '../shared/permission-tool-rules.js';

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
  return rules.every((rule) =>
    persistentRuleForSuggestion(rule, {
      semanticCapabilityDefinitions: request.semanticCapabilityDefinitions,
    }),
  )
    ? candidates
    : [];
}

export function persistentRules(request: PermissionApprovalRequest): string[] {
  const [update] = persistentPermissionUpdates(request);
  return (update?.rules || [])
    .map((rule) =>
      persistentRuleForSuggestion(rule, {
        semanticCapabilityDefinitions: request.semanticCapabilityDefinitions,
      }),
    )
    .filter((rule): rule is string => Boolean(rule));
}

export function firstPersistentRule(
  request: PermissionApprovalRequest,
): string | undefined {
  return persistentRules(request)[0];
}

function persistentRuleForSuggestion(
  rule: PermissionApprovalRuleValue,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): string | undefined {
  if (!rule?.toolName) return undefined;
  const [persistentRule] = permissionUpdateAllowedToolRules([
    {
      type: 'addRules',
      behavior: 'allow',
      rules: [rule],
    },
  ]);
  if (!persistentRule) return undefined;
  return validateDurableAccessRule(persistentRule, {
    semanticCapabilityDefinitions: options.semanticCapabilityDefinitions,
  }).ok
    ? persistentRule
    : undefined;
}

function isPermissionDecisionModeAllowed(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
): boolean {
  if (request.decisionOptions?.length) {
    return request.decisionOptions.includes(mode);
  }
  if (mode === 'allow_persistent_rule') {
    return Boolean(firstPersistentRule(request));
  }
  return mode === 'allow_once' || mode === 'allow_timed_grant';
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
  if (!isPermissionDecisionModeAllowed(request, mode)) {
    return {
      approved: false,
      mode: 'cancel',
      decidedBy,
      reason: 'approval option unavailable',
      decisionClassification: 'user_reject',
    };
  }
  if (mode === 'allow_timed_grant') {
    return {
      approved: true,
      mode,
      decidedBy,
      reason: `timed grant for eligible tools and SDK API prompts (${Math.round(TIMED_GRANT_DURATION_MS / 60000)} min)`,
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
