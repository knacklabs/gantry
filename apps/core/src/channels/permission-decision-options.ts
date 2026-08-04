import {
  firstPersistentRule,
  PERSISTENT_RULE_APPROVAL_MAX_RULES,
} from '../domain/permission-decision.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { withRecoveredBatchOption } from './permission-batch-coalescer.js';

export function normalizePermissionAction(
  action: string,
): PermissionApprovalDecisionMode | null {
  if (action === 'allow_once') return 'allow_once';
  if (action === 'allow_persistent_rule') return 'allow_persistent_rule';
  if (action === 'cancel') return 'cancel';
  return null;
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
  matchKind?: 'individual' | 'batch',
): PermissionApprovalDecisionMode[] {
  const rule = firstPersistentRule(request);
  const requested = request.decisionOptions;
  const fallback: PermissionApprovalDecisionMode[] = rule
    ? ['allow_once', 'allow_persistent_rule', 'cancel']
    : ['allow_once', 'cancel'];
  const options = requested?.length ? requested : fallback;
  if (!requested?.length && !rule) logOptionDrop(request);
  return withRecoveredBatchOption(options, matchKind);
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
