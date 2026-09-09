import type {
  PermissionApprovalDecisionMode,
  PermissionRememberCode,
} from './types.js';

export type PermissionCardAffordances = {
  eligible: boolean;
  offered: PermissionRememberCode[];
  alternative?: {
    code: PermissionApprovalDecisionMode | PermissionRememberCode;
    label: string;
    line: string;
  };
  destructive: boolean;
  protected: boolean;
  preTapLines: string[];
  postTapLines: Partial<Record<PermissionRememberCode, string>>;
};
