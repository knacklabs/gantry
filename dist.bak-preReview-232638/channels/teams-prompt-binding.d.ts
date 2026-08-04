import type { PermissionApprovalRequest } from '../domain/types.js';
export declare function bindTeamsPermissionPromptMessage(request: PermissionApprovalRequest, conversationId: string, callbackId: string, externalMessageId?: string): Promise<boolean>;
