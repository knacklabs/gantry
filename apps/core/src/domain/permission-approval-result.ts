import type { PermissionApprovalDecision } from './types.js';

export type PermissionApprovalResult =
  | { kind: 'decision'; decision: PermissionApprovalDecision }
  | {
      kind: 'delivery_failure';
      code: 'target_missing' | 'surface_unsupported' | 'provider_failed';
      retryable: boolean;
      delivered: 'no' | 'unknown';
      userMessage: string;
    };
