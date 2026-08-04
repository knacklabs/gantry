import type { PermissionApprovalRequest } from '../domain/types.js';
type PermissionTextSanitizer = (input: string, head: number, tail: number) => string;
export declare function permissionRiskLines(request: PermissionApprovalRequest): string[];
export declare function formatPermissionToolInputLines(request: PermissionApprovalRequest, sanitizePermissionText: PermissionTextSanitizer, options?: {
    sanitizeCommandText?: PermissionTextSanitizer;
}): string[];
export declare function runtimeDisplayCommand(command: string): {
    command: string;
    runtimeEnvAssignments: string[];
};
export {};
