import { logger } from '../infrastructure/logging/logger.js';
import { DISCORD_API_ROOT, discordHeaders, } from './discord-interaction-helpers.js';
import { formatPermissionReceiptText } from './permission-interaction.js';
const settling = new WeakSet();
export function timeoutRetryDelays(timeoutMs) {
    const firstDelay = Math.floor(timeoutMs / 3);
    return [firstDelay, timeoutMs - firstDelay];
}
export function pending(callback, request, sent, channelId, resolve, timeout) {
    return {
        callback,
        request,
        channelId,
        externalMessageId: sent.externalMessageIds?.at(-1) ?? sent.externalMessageId,
        resolve,
        timeout,
    };
}
export function drop(pendingPermissions, request) {
    for (const [providerAlias, live] of pendingPermissions) {
        if (live.request.requestId !== request.requestId ||
            live.request.sourceAgentFolder !== request.sourceAgentFolder ||
            (live.request.appId || 'default') !== (request.appId || 'default')) {
            continue;
        }
        clearTimeout(live.timeout);
        pendingPermissions.delete(providerAlias);
    }
}
export async function consume(pending, input, decision) {
    if (settling.has(pending))
        return false;
    settling.add(pending);
    try {
        const messageId = pending.externalMessageId;
        if (messageId) {
            const approved = decision.approved && decision.mode !== 'cancel';
            const url = `${DISCORD_API_ROOT}/channels/${encodeURIComponent(pending.channelId)}/messages/${encodeURIComponent(messageId)}`;
            if (approved) {
                try {
                    const response = await fetch(url, {
                        method: 'DELETE',
                        headers: discordHeaders(input.botToken),
                    });
                    if (!response.ok)
                        throw new Error('Discord permission prompt delete failed');
                    return true;
                }
                catch (err) {
                    logger.debug({
                        requestId: pending.request?.requestId ??
                            decision.permissionCallbackClaim?.scope.interactionId,
                        err,
                    }, 'Failed to delete approved Discord permission prompt; replacing with fallback receipt');
                }
            }
            const response = await fetch(url, {
                method: 'PATCH',
                headers: discordHeaders(input.botToken),
                body: JSON.stringify({
                    content: decision.reason === 'timed out'
                        ? 'Permission request timed out.'
                        : pending.request
                            ? formatPermissionReceiptText(pending.request.requestId, pending.request, decision)
                            : approved
                                ? 'Permission allowed.'
                                : 'Permission request denied.',
                    components: [],
                }),
            });
            if (!response.ok)
                throw new Error('Discord permission prompt update failed');
        }
        return true;
    }
    catch (err) {
        settling.delete(pending);
        throw err;
    }
}
export async function settle(pendingPermissions, providerAlias, decision, input) {
    const pending = pendingPermissions.get(providerAlias);
    if (!pending)
        return false;
    try {
        if (!(await consume(pending, input, decision)))
            return false;
    }
    catch (err) {
        logger.debug({ requestId: pending.request.requestId, err }, 'Failed to settle Discord permission prompt message');
        return false;
    }
    clearTimeout(pending.timeout);
    pendingPermissions.delete(providerAlias);
    pending.resolve(decision);
    return true;
}
