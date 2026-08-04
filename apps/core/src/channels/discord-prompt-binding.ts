import { bindPendingPermissionInteractionMessage } from '../application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import type { PermissionPromptFullView } from './permission-full-view.js';
import { permissionDecisionOptions } from './permission-interaction.js';

export async function bindDiscordPermissionPrompt(
  request: PermissionApprovalRequest,
  conversationId: string,
  callbackId: string,
  externalMessageId?: string,
  fullView?: PermissionPromptFullView,
): Promise<boolean> {
  const bound = await bindPendingPermissionInteractionMessage({
    request,
    decisionOptions: permissionDecisionOptions(request),
    callbackId,
    ...(externalMessageId ? { externalMessageId } : {}),
    provider: 'discord',
    conversationId,
    fullView,
  });
  return bound;
}
