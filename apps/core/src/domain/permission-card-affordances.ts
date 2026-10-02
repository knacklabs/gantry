import type { PermissionRememberCode } from './types.js';

export type PermissionCardAffordances = {
  eligible: boolean;
  offered: PermissionRememberCode[];
  destructive: boolean;
  protected: boolean;
  preTapLines: string[];
  postTapLines: Partial<Record<PermissionRememberCode, string>>;
};
