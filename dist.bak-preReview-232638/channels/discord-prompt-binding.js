import { bindPendingPermissionInteractionMessage } from '../application/interactions/pending-interaction-durability.js';
import { permissionDecisionOptions } from './permission-interaction.js';
export async function bindDiscordPermissionPrompt(request, conversationId, callbackId, externalMessageId, fullView) {
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
