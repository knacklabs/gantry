export const CHAT_BATCH_PROVIDER_MIN_ITEMS = 100;
export function supportsChatBatch(provider) {
    return Boolean(provider.batch);
}
export function resolveChatBatchMode(input) {
    if (!input.enabled || input.mode === 'inline')
        return 'inline';
    if (!supportsChatBatch(input.provider))
        return 'inline';
    if (input.mode === 'provider_batch')
        return 'provider_batch';
    const minItems = Math.max(1, Math.floor(input.minItems ?? CHAT_BATCH_PROVIDER_MIN_ITEMS));
    return input.itemCount >= minItems ? 'provider_batch' : 'inline';
}
