import type { PermissionApprovalRequest } from '../../domain/types.js';
export interface DurablePermissionFullView {
    label: string;
    title: string;
    filename: string;
    content: string;
}
export declare function durablePermissionRequestSnapshot(request: PermissionApprovalRequest): PermissionApprovalRequest;
export declare function readDurablePermissionFullView(value: unknown): DurablePermissionFullView | undefined;
export declare function permissionRequestFromPayload(payload: Record<string, unknown>): PermissionApprovalRequest | null;
export declare function isStringOrNull(value: unknown): value is string | null;
