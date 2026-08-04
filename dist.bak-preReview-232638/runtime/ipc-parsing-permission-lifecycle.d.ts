import type { PermissionApprovalCancellation, PermissionApprovalRequest, UserQuestionCancellation } from '../domain/types.js';
export declare function parsePermissionLifecycle(raw: Record<string, unknown>): Pick<PermissionApprovalRequest, 'permissionLane' | 'expiresAt'>;
export declare function parsePermissionCancellationIpcRequest(raw: unknown, sourceAgentFolder: string): PermissionApprovalCancellation;
export declare function parseQuestionCancellationIpcRequest(raw: unknown, sourceAgentFolder: string): UserQuestionCancellation;
