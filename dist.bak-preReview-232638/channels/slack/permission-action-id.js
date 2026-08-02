export const SLACK_PERMISSION_DECISION_ACTION_ID = 'gantry_perm_decision';
export const SLACK_PERMISSION_DECISION_ACTION_IDS = [
    SLACK_PERMISSION_DECISION_ACTION_ID,
    slackPermissionDecisionActionId('allow_once'),
    slackPermissionDecisionActionId('allow_persistent_rule'),
    slackPermissionDecisionActionId('cancel'),
];
export function slackPermissionDecisionActionId(mode) {
    return `${SLACK_PERMISSION_DECISION_ACTION_ID}_${mode}`;
}
