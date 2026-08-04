import type { PermissionApprovalDecisionMode } from '../../domain/types.js';
export declare const SLACK_PERMISSION_DECISION_ACTION_ID = "gantry_perm_decision";
export declare const SLACK_PERMISSION_DECISION_ACTION_IDS: readonly string[];
export declare function slackPermissionDecisionActionId(mode: PermissionApprovalDecisionMode): string;
