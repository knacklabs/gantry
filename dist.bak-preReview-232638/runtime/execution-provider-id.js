export function resolveRuntimeExecutionProviderId(executionAdapter) {
    const id = executionAdapter?.id?.trim();
    if (!id) {
        throw new Error('Runtime execution adapter is not configured.');
    }
    return id;
}
export function resolveConfiguredRuntimeExecutionProviderId(input) {
    const executionAdapter = input.executionAdapter ?? input.executionAdapters?.list()[0];
    if (executionAdapter)
        return resolveRuntimeExecutionProviderId(executionAdapter);
    if (input.fallbackExecutionProviderId)
        return input.fallbackExecutionProviderId;
    return resolveRuntimeExecutionProviderId();
}
