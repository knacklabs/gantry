import { settleDeliveryAttempt } from '../jobs/delivery.js';
export const MODEL_ACCESS_AUTH_FAILURE_MESSAGE = 'Model Access authentication failed. Update the provider API key in Model Access, then send the message again.';
export function isModelAccessAuthFailure(error) {
    if (!error)
        return false;
    const normalized = error.toLowerCase();
    return (normalized.includes('authentication_error') ||
        normalized.includes('failed to authenticate') ||
        normalized.includes('invalid bearer token') ||
        normalized.includes('invalid api key') ||
        normalized.includes('api error: 401'));
}
export async function sendModelAccessAuthFailureNotice(input) {
    return settleDeliveryAttempt(() => input.sendMessageToChannel(MODEL_ACCESS_AUTH_FAILURE_MESSAGE, input.messageOptions), { scope: 'runtime-nonretryable-model-auth-error', target: input.chatJid }).catch((err) => {
        input.warn({ err, group: input.groupName }, 'Failed to send Model Access auth failure notice');
        return 'not_delivered';
    });
}
