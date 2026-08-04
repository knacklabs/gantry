import type { PermissionApprovalRequest, PermissionApprovalUpdate } from '../../domain/types.js';
export declare function synthesizeHostPermissionSuggestions(toolName: string, toolInput: unknown): PermissionApprovalUpdate[] | undefined;
export declare function permissionSuggestionKey(agentFolder: string, suggestions: PermissionApprovalRequest['suggestions']): string | undefined;
