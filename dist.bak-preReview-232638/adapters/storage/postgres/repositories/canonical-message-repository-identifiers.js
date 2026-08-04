import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
export function messageIdFor(chatJid, id, providerAccountId) {
    return providerAccountId
        ? `message:${providerAccountId}:${chatJid}:${id}`
        : `message:${chatJid}:${id}`;
}
function parseExternalRef(value) {
    if (!value)
        return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
export function publicThreadIdForRow(chatJid, threadId, externalRefJson) {
    const refThreadId = parseExternalRef(externalRefJson).thread_id;
    if (typeof refThreadId === 'string' && refThreadId.length > 0) {
        return refThreadId;
    }
    const unscopedPrefix = `thread:${chatJid}:`;
    if (threadId.startsWith(unscopedPrefix)) {
        return threadId.slice(unscopedPrefix.length);
    }
    const scopedSuffix = `:${chatJid}:`;
    const scopedIndex = threadId.indexOf(scopedSuffix);
    return scopedIndex >= 0
        ? threadId.slice(scopedIndex + scopedSuffix.length)
        : threadId;
}
export function liveAdmissionWorkItemId(appId, canonicalMessageId, providerAccountId, agentId) {
    return [
        'live-admission',
        appId,
        agentId?.trim() || 'default-agent',
        providerAccountId?.trim() || 'default-provider-account',
        canonicalMessageId,
    ].join(':');
}
export function liveAdmissionIdempotencyKey(msg, appId, providerId, providerAccountId, agentId) {
    const providerMessageId = msg.external_message_id?.trim() || msg.id;
    const providerScope = providerAccountId?.trim() || providerId;
    return [
        'live-admission',
        appId,
        agentId?.trim() || 'default-agent',
        providerScope,
        msg.chat_jid,
        msg.thread_id?.trim() || 'main',
        providerMessageId,
    ].join(':');
}
export function externalRefForMessage(msg) {
    const retryTailPayload = sanitizeRetryTailProviderPayload(msg.delivery_retry_tail?.providerPayload);
    const retryTail = msg.delivery_retry_tail
        ? {
            canonicalText: msg.delivery_retry_tail.canonicalText,
            ...(retryTailPayload !== undefined
                ? { providerPayload: retryTailPayload }
                : {}),
        }
        : undefined;
    return {
        kind: 'message',
        id: msg.id,
        chat_jid: msg.chat_jid,
        provider: msg.provider,
        provider_account_id: msg.providerAccountId,
        thread_id: msg.thread_id,
        external_message_id: msg.external_message_id,
        reply_to_message_id: msg.reply_to_message_id,
        reply_to_sender_name: msg.reply_to_sender_name,
        response_schema: msg.responseSchema,
        effort: msg.agentControls?.effort,
        thinking: msg.agentControls?.thinking,
        max_output_tokens: msg.agentControls?.maxOutputTokens,
        delivery_retry_tail: retryTail,
    };
}
