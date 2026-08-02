const DEFAULT_APP_ID = 'default';
export function pendingInteractionIdempotencyKey(input) {
    return [
        input.appId || DEFAULT_APP_ID,
        input.kind,
        input.sourceAgentFolder,
        input.requestId,
    ].join(':');
}
