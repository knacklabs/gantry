export function isVisibleResultFrame(output) {
    return typeof output.result === 'string' && output.result.length > 0;
}
export function isRunnerCompletionEvidenceFrame(output) {
    if (output.status !== 'success')
        return false;
    if (output.sessionInit ||
        output.runtimeEventOnly ||
        output.compactBoundary ||
        output.interactionBoundary) {
        return false;
    }
    if (isVisibleResultFrame(output))
        return true;
    if (output.result !== null)
        return false;
    if (output.usage || output.usageEventId || output.contextUsage)
        return true;
    return !output.runtimeEvents?.length;
}
export function isAgentTurnCompleteMarker(result) {
    return (result.status === 'success' &&
        !result.result &&
        !result.sessionInit &&
        !result.runtimeEventOnly &&
        !result.compactBoundary &&
        !result.interactionBoundary);
}
export function createSerializedAgentOutputCallbacks(args) {
    let chain = Promise.resolve();
    return {
        enqueue(result) {
            const next = chain.then(() => args.handle(result));
            chain = next.catch(args.onError);
            return next;
        },
        wait() {
            return chain;
        },
    };
}
