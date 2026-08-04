export function maintenanceCompactionPromptForExecutionProvider(executionProviderId, input) {
    const adapter = input.executionAdapters?.get(executionProviderId) ??
        (input.executionAdapter?.id === executionProviderId
            ? input.executionAdapter
            : undefined);
    return adapter?.sessionCompactionPrompt?.();
}
