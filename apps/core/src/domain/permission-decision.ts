import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalRuleValue,
  PermissionApprovalUpdate,
  PermissionDecisionSource,
} from './types.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { validateDurableAccessRule } from '../shared/durable-access-policy.js';
import { permissionUpdateAllowedToolRules } from '../shared/permission-tool-rules.js';

export const PERSISTENT_RULE_APPROVAL_MAX_RULES = 5;

export interface PermissionAuthorityAddition {
  type: 'addRules' | 'replaceRules';
  behavior: 'allow';
  rules: PermissionApprovalRuleValue[];
  destination?: PermissionApprovalUpdate['destination'];
}

export function permissionAuthorityAddition(
  update: PermissionApprovalUpdate | undefined,
): PermissionAuthorityAddition | null {
  const allowedDestinations = new Set([
    'userSettings',
    'projectSettings',
    'localSettings',
    'session',
    'cliArg',
  ]);
  if (
    !update ||
    Object.keys(update).some(
      (key) => !['type', 'behavior', 'rules', 'destination'].includes(key),
    ) ||
    (update.type !== 'addRules' && update.type !== 'replaceRules') ||
    update.behavior !== 'allow' ||
    !Array.isArray(update.rules) ||
    update.rules.length === 0 ||
    update.rules.length > PERSISTENT_RULE_APPROVAL_MAX_RULES ||
    (update.destination !== undefined &&
      !allowedDestinations.has(update.destination)) ||
    update.rules.some(
      (rule) =>
        !rule ||
        Object.keys(rule).some(
          (key) => !['toolName', 'ruleContent'].includes(key),
        ) ||
        typeof rule.toolName !== 'string' ||
        !rule.toolName.trim() ||
        (rule.ruleContent !== undefined &&
          (typeof rule.ruleContent !== 'string' || !rule.ruleContent.trim())),
    )
  ) {
    return null;
  }
  return {
    type: update.type,
    behavior: 'allow',
    rules: update.rules.map((rule) => ({
      toolName: rule.toolName.trim(),
      ...(rule.ruleContent ? { ruleContent: rule.ruleContent.trim() } : {}),
    })),
    ...(update.destination ? { destination: update.destination } : {}),
  };
}

const PERMISSION_PROVENANCE_BY_DECIDER: Record<
  string,
  { source: PermissionDecisionSource; repeatableForFutureRuns: boolean }
> = {
  reviewed_rule: { source: 'durable_rule', repeatableForFutureRuns: true },
  birthright: { source: 'birthright', repeatableForFutureRuns: true },
  deterministic_read_only: {
    source: 'deterministic_policy',
    repeatableForFutureRuns: true,
  },
  auto_classifier: {
    source: 'auto_classifier',
    repeatableForFutureRuns: true,
  },
  cached_classifier_verdict: {
    source: 'cached_classifier',
    repeatableForFutureRuns: true,
  },
  trusted_root_grant: {
    source: 'trusted_root',
    repeatableForFutureRuns: true,
  },
};

export type PermissionDecisionOrigin = 'machine' | 'human';

function permissionProvenance(
  mode: PermissionApprovalDecisionMode,
  decidedBy?: string,
  origin?: PermissionDecisionOrigin,
): { source: PermissionDecisionSource; repeatableForFutureRuns: boolean } {
  const humanProvenance =
    mode === 'allow_persistent_rule'
      ? ({ source: 'human_persistent', repeatableForFutureRuns: true } as const)
      : ({ source: 'human_once', repeatableForFutureRuns: false } as const);
  // A structurally human decision NEVER consults the decider map: decidedBy
  // is a free-form approverRef there, and an approver literally named
  // 'auto_classifier' must not be promoted to repeatable machine provenance.
  if (origin === 'human') return humanProvenance;
  // Machine/unspecified: own-property check keeps prototype keys like
  // 'constructor' from resolving as recognized deciders; unknown deciders
  // fall back to the conservative human semantics.
  return (
    (decidedBy && Object.hasOwn(PERMISSION_PROVENANCE_BY_DECIDER, decidedBy)
      ? PERMISSION_PROVENANCE_BY_DECIDER[decidedBy]
      : undefined) ?? humanProvenance
  );
}

function decisionClassification(
  approved: boolean,
  source: PermissionDecisionSource,
): PermissionApprovalDecision['decisionClassification'] {
  if (!approved) return 'user_reject';
  return source === 'human_once' ? 'user_temporary' : 'user_permanent';
}

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
  return mode === 'allow_once';
}

export function decisionForMode(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
  decidedBy?: string,
  origin?: PermissionDecisionOrigin,
): PermissionApprovalDecision {
  const provenance = permissionProvenance(mode, decidedBy, origin);
  if (mode === 'cancel') {
    return {
      approved: false,
      mode,
      decidedBy,
      ...provenance,
      reason: request.closestRule
        ? 'The attempted command did not match an approved pattern.'
        : 'Access for this tool was not granted.',
      decisionClassification: decisionClassification(false, provenance.source),
    };
  }
  if (!isPermissionDecisionModeAllowed(request, mode)) {
    return {
      approved: false,
      mode: 'cancel',
      decidedBy,
      ...provenance,
      reason: 'approval option unavailable',
      decisionClassification: decisionClassification(false, provenance.source),
    };
  }
  if (mode === 'allow_persistent_rule') {
    const updates = persistentPermissionUpdates(request).map((update) => ({
      ...update,
      destination: 'session' as const,
    }));
    if (updates.length === 0) {
      // Learned-root ask-once (PERM-2 Task G): "remember this folder" carries no
      // tool-rule suggestion, so approve it directly instead of collapsing to
      // cancel. The coordinator turns this approval into the persisted grant.
      if (request.trustedRootLearn) {
        return {
          approved: true,
          mode,
          decidedBy,
          ...provenance,
          reason: 'trusted root remembered',
          decisionClassification: decisionClassification(
            true,
            provenance.source,
          ),
        };
      }
      return {
        approved: false,
        mode: 'cancel',
        decidedBy,
        ...provenance,
        reason: 'persistent rule unavailable',
        decisionClassification: decisionClassification(
          false,
          provenance.source,
        ),
      };
    }
    return {
      approved: true,
      mode,
      decidedBy,
      ...provenance,
      reason: 'persistent rule allowed',
      updatedPermissions: updates,
      decisionClassification: decisionClassification(true, provenance.source),
    };
  }
  return {
    approved: true,
    mode,
    decidedBy,
    ...provenance,
    reason: 'allowed once',
    decisionClassification: decisionClassification(true, provenance.source),
  };
}
