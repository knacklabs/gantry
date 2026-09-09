import { bindPendingPermissionInteractionMessage } from '../../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import { permissionDecisionOptions } from '../permission-card-affordances.js';

export async function bindTeamsPermissionPromptMessage(
  request: PermissionApprovalRequest,
  conversationId: string,
  callbackId: string,
  externalMessageId?: string,
): Promise<boolean> {
  if (!externalMessageId) return false;
  return bindPendingPermissionInteractionMessage({
    request,
    decisionOptions: permissionDecisionOptions(request),
    callbackId,
    externalMessageId,
    provider: 'teams',
    conversationId,
  });
}
