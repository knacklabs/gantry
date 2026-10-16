import {
  firstPersistentRule,
  PERSISTENT_RULE_APPROVAL_MAX_RULES,
} from '../domain/permission-decision.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';

const PROMPT_ORDER: readonly PermissionApprovalDecisionMode[] = [
  'allow_once',
  'allow_persistent_rule',
  'cancel',
];

export function normalizePermissionAction(
  action: string,
): PermissionApprovalDecisionMode | null {
  if (action === 'allow_once') return 'allow_once';
  if (action === 'allow_persistent_rule') return 'allow_persistent_rule';
  if (action === 'cancel') return 'cancel';
  return null;
}

/** Allow once, Allow for future (only when the request can save), Deny —
 *  always in that order, and Deny is always offered. */
export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
): PermissionApprovalDecisionMode[] {
  const rule = firstPersistentRule(request);
  const requested = request.decisionOptions;
  if (!requested?.length && !rule) logOptionDrop(request);
  const offered: readonly PermissionApprovalDecisionMode[] = requested?.length
    ? requested
    : rule
      ? PROMPT_ORDER
      : ['allow_once'];
  return PROMPT_ORDER.filter(
    (mode) => mode === 'cancel' || offered.includes(mode),
  );
}

function logOptionDrop(request: PermissionApprovalRequest): void {
  const suggestions = request.suggestions || [];
  if (suggestions.length === 0) return;
  logger.debug(
    {
      requestId: request.requestId,
      toolName: request.toolName,
      suggestionCount: suggestions.length,
      reason: persistentOptionDropReason(request),
    },
    'Persistent permission option unavailable',
  );
}

function persistentOptionDropReason(
  request: PermissionApprovalRequest,
): string {
  const candidates = (request.suggestions || []).filter(
    (update) =>
      (update.type === 'addRules' || update.type === 'replaceRules') &&
      update.behavior === 'allow' &&
      Array.isArray(update.rules) &&
      update.rules.length > 0,
  );
  if (candidates.length !== 1) return 'expected exactly one allow rule update';
  if (!candidates[0].rules?.length) return 'expected at least one rule';
  if (candidates[0].rules.length > PERSISTENT_RULE_APPROVAL_MAX_RULES) {
    return `expected at most ${PERSISTENT_RULE_APPROVAL_MAX_RULES} rules`;
  }
  return 'rule missing toolName';
}
