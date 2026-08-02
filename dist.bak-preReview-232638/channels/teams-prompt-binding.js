import { bindPendingPermissionInteractionMessage } from '../application/interactions/pending-interaction-durability.js';
import { permissionDecisionOptions } from './permission-interaction.js';
export async function bindTeamsPermissionPromptMessage(request, conversationId, callbackId, externalMessageId) {
    if (!externalMessageId)
        return false;
    return bindPendingPermissionInteractionMessage({
        request,
        decisionOptions: permissionDecisionOptions(request),
        callbackId,
        externalMessageId,
        provider: 'teams',
        conversationId,
    });
}
