import type { PermissionApprovalRequest } from '../domain/types.js';
import type { PermissionPromptFullView } from './permission-full-view.js';
export declare function bindDiscordPermissionPrompt(request: PermissionApprovalRequest, conversationId: string, callbackId: string, externalMessageId?: string, fullView?: PermissionPromptFullView): Promise<boolean>;
