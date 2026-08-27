export interface PermissionApprovalRuleValue {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionApprovalUpdate {
  type:
    | 'addRules'
    | 'replaceRules'
    | 'removeRules'
    | 'setMode'
    | 'addDirectories'
    | 'removeDirectories';
  rules?: PermissionApprovalRuleValue[];
  behavior?: 'allow' | 'deny' | 'ask';
  destination?:
    | 'userSettings'
    | 'projectSettings'
    | 'localSettings'
    | 'session'
    | 'cliArg';
  mode?: string;
  directories?: string[];
}
