import type { PermissionApprovalDecisionMode } from '../../domain/types.js';

export const SLACK_PERMISSION_DECISION_ACTION_ID = 'gantry_perm_decision';

export const SLACK_PERMISSION_DECISION_ACTION_IDS: readonly string[] = [
  SLACK_PERMISSION_DECISION_ACTION_ID,
  slackPermissionDecisionActionId('allow_once'),
  slackPermissionDecisionActionId('allow_persistent_rule'),
  slackPermissionDecisionActionId('cancel'),
] as const;

export function slackPermissionDecisionActionId(
  mode: PermissionApprovalDecisionMode,
): string {
  return `${SLACK_PERMISSION_DECISION_ACTION_ID}_${mode}`;
}
