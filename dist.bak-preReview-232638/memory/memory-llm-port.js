let registeredClient;
export function registerMemoryLlmClient(client) {
    registeredClient = client;
}
const unconfiguredMemoryLlmClient = {
    isConfigured: () => false,
    query: async () => {
        throw new Error('Memory LLM client is not configured. Runtime bootstrap must register a MemoryLlmClient.');
    },
};
export function getMemoryLlmClient() {
    return registeredClient ?? unconfiguredMemoryLlmClient;
}
