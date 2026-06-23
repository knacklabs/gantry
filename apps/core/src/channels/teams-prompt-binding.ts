import { bindPendingPermissionInteractionMessage } from '../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '../domain/types.js';

export function bindTeamsPermissionPromptMessage(
  request: PermissionApprovalRequest,
  conversationId: string,
  externalMessageId?: string,
): void {
  if (!externalMessageId) return;
  void bindPendingPermissionInteractionMessage({
    sourceAgentFolder: request.sourceAgentFolder,
    requestId: request.requestId,
    appId: request.appId,
    externalMessageId,
    provider: 'teams',
    conversationId,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  });
}
