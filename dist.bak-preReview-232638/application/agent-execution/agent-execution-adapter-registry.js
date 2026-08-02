export function createAgentExecutionAdapterRegistry(adapters) {
    const byId = new Map();
    for (const adapter of adapters) {
        const id = adapter.id?.trim();
        if (!id) {
            throw new Error('Agent execution adapter id is required.');
        }
        if (byId.has(id)) {
            throw new Error(`Duplicate agent execution adapter id: ${id}`);
        }
        byId.set(id, adapter);
    }
    return {
        get: (id) => byId.get(id.trim()),
        has: (id) => byId.has(id.trim()),
        list: () => [...byId.values()],
    };
}
export function resolveAgentExecutionAdapter(input) {
    const executionProviderId = input.executionProviderId?.trim();
    if (executionProviderId) {
        const registered = input.registry?.get(executionProviderId);
        if (registered)
            return registered;
        if (input.fallback?.id === executionProviderId)
            return input.fallback;
        throw new Error(`Unsupported model execution provider: ${executionProviderId}`);
    }
    return input.fallback ?? input.registry?.list()[0];
}
export function executionProviderIdForAdapter(adapter) {
    return adapter.id;
}
