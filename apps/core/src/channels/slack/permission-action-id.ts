import type {
  PermissionApprovalDecisionMode,
  PermissionRememberCode,
} from '../../domain/types.js';

export const SLACK_PERMISSION_DECISION_ACTION_ID = 'gantry_perm_decision';

export const SLACK_PERMISSION_DECISION_ACTION_IDS: readonly string[] = [
  SLACK_PERMISSION_DECISION_ACTION_ID,
  slackPermissionDecisionActionId('allow_once'),
  slackPermissionDecisionActionId('allow_persistent_rule'),
  slackPermissionDecisionActionId('cancel'),
  slackPermissionDecisionActionId('remember_allow_exact'),
  slackPermissionDecisionActionId('remember_allow_kind'),
  slackPermissionDecisionActionId('remember_allow_place'),
  slackPermissionDecisionActionId('remember_deny_exact'),
] as const;

export function slackPermissionDecisionActionId(
  mode: PermissionApprovalDecisionMode | PermissionRememberCode,
): string {
  return `${SLACK_PERMISSION_DECISION_ACTION_ID}_${mode}`;
}
