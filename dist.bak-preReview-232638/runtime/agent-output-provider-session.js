export function providerSessionExternalSessionId(output) {
    return (output.providerSession?.externalSessionId?.trim() ||
        output.newSessionId?.trim() ||
        undefined);
}
export function outputWithProviderSession(output, externalSessionId) {
    const resolved = externalSessionId ?? providerSessionExternalSessionId(output);
    if (!resolved)
        return output;
    return {
        ...output,
        providerSession: { externalSessionId: resolved },
        newSessionId: output.newSessionId ?? resolved,
    };
}
export function runnerResultWithProviderSession(input) {
    return outputWithProviderSession({
        status: input.status,
        result: null,
        ...(input.error ? { error: input.error } : {}),
    }, input.externalSessionId);
}
