import { DEFAULT_EMBED_MODEL } from '../config/settings/runtime-settings-defaults.js';
import { createEmbeddingProvider, isEmbeddingProviderRegistered, } from '../memory/memory-embeddings.js';
function inspectMemoryStorage(memoryEnabled) {
    if (!memoryEnabled) {
        return {
            status: 'pass',
            message: 'Memory is disabled in settings.yaml.',
        };
    }
    return {
        status: 'pass',
        message: 'Memory uses Postgres app-grade tables; database readiness is checked by doctor.',
    };
}
function inspectEmbeddings(input) {
    if (!input.memoryEnabled) {
        return {
            status: 'pass',
            message: 'Memory is disabled, so embeddings are not required.',
        };
    }
    if (!input.embeddingsEnabled) {
        return {
            status: 'pass',
            message: 'Embeddings are optional and currently disabled in settings.yaml.',
        };
    }
    if (!isEmbeddingProviderRegistered(input.embeddingProvider)) {
        return {
            status: 'fail',
            message: `Unknown embedding provider "${input.embeddingProvider}".`,
            nextAction: 'Set memory.embeddings.provider to openai, or disable embeddings.',
        };
    }
    try {
        createEmbeddingProvider(input.embeddingProvider).validateConfiguration();
    }
    catch (err) {
        return {
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
            nextAction: 'Keep embeddings off, or configure brokered embedding-provider support in Model Access before enabling this provider.',
        };
    }
    if (!/embedding/i.test(input.embeddingModel)) {
        return {
            status: 'fail',
            message: 'Embedding provider configuration is invalid.',
            nextAction: 'Set memory.embeddings.model to an embedding model or disable embeddings.',
        };
    }
    return {
        status: 'pass',
        message: `${input.embeddingProvider} embeddings provider is configured.`,
    };
}
export function inspectMemoryHealth(_runtimeHome, settings, env) {
    const warnings = [];
    const settingsMemory = settings?.memory;
    const storageProvider = 'postgres';
    const memoryEnabled = settingsMemory?.enabled ?? true;
    const embeddingsEnabled = settingsMemory?.embeddings.enabled ?? false;
    const dreamingEnabled = settingsMemory?.dreaming.enabled ?? false;
    const embeddingProvider = settingsMemory
        ? settingsMemory.embeddings.enabled
            ? settingsMemory.embeddings.provider
            : 'disabled'
        : 'disabled';
    const embeddingModel = settingsMemory?.embeddings.model || DEFAULT_EMBED_MODEL;
    const memoryCheck = inspectMemoryStorage(memoryEnabled);
    const embeddingCheck = inspectEmbeddings({
        memoryEnabled,
        embeddingsEnabled,
        embeddingProvider,
        embeddingModel,
        env,
    });
    return {
        storageProvider,
        memoryEnabled,
        embeddingsEnabled,
        dreamingEnabled,
        embeddingProvider,
        embeddingModel,
        memorySource: settingsMemory ? 'settings.yaml' : 'default',
        embeddingProviderSource: settingsMemory ? 'settings.yaml' : 'default',
        embeddingModelSource: settingsMemory?.embeddings.model
            ? 'settings.yaml'
            : 'default',
        dreamingSource: settingsMemory ? 'settings.yaml' : 'default',
        memoryCheck,
        embeddingCheck,
        warnings,
    };
}
