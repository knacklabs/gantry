import { bindPendingPermissionInteractionMessage } from '../../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';

export function bindTelegramPermissionPromptMessage(
  request: PermissionApprovalRequest,
  chatId: string,
  messageId: number,
): void {
  void bindPendingPermissionInteractionMessage({
    sourceAgentFolder: request.sourceAgentFolder,
    requestId: request.requestId,
    appId: request.appId,
    externalMessageId: String(messageId),
    provider: 'telegram',
    conversationId: chatId,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  });
}
