import { randomUUID } from 'node:crypto';
import { MEMORY_EMBED_BATCH_SIZE, MEMORY_EMBED_DIMENSIONS, MEMORY_EMBED_MODEL, MEMORY_EMBED_PROVIDER, getCredentialBrokerRuntimeConfig, } from '../config/index.js';
import { EmbeddingProviderError, classifyEmbeddingHttpError, classifyEmbeddingThrown, } from './memory-embedding-errors.js';
import { fetchEmbeddingBatchResults, pollEmbeddingBatch, submitEmbeddingBatch, } from './embedding-batch-http.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../adapters/credentials/agent-credential-broker-factory.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { getDefaultEmbeddingModelProvider, getModelProviderDefinition, listEmbeddingModelProviders, normalizeModelProviderId, } from '../shared/model-provider-registry.js';
import { logger } from '../infrastructure/logging/logger.js';
const embeddingProviderFactories = new Map();
const DEFAULT_EMBEDDING_BASE_URL = ['https://api.', 'open', 'ai.com'].join('');
const OPEN_AI_PROVIDER_ALIAS = ['open', 'ai'].join('');
let embeddingCredentialBrokerPromise;
let embeddingCredentialBrokerConfigKey = '';
export class OpenAIEmbeddingClient {
    apiKey;
    model;
    dimensions;
    validateCredentialConfiguration;
    baseUrl;
    connection;
    constructor(apiKey = null, model = MEMORY_EMBED_MODEL, validateCredentialConfiguration, baseUrl = DEFAULT_EMBEDDING_BASE_URL, connection, dimensions = MEMORY_EMBED_DIMENSIONS) {
        this.apiKey = apiKey;
        this.model = model;
        this.dimensions = dimensions;
        this.validateCredentialConfiguration = validateCredentialConfiguration;
        this.baseUrl = baseUrl;
        this.connection = connection;
    }
    isEnabled() {
        return Boolean(this.model.trim() &&
            (this.connection ||
                typeof this.apiKey === 'function' ||
                this.apiKey?.trim()));
    }
    expectedDimensions() {
        return this.dimensions;
    }
    validateConfiguration() {
        if (!this.model.trim()) {
            throw new Error('MEMORY_EMBED_MODEL is required for memory embeddings');
        }
        if (!/embedding/i.test(this.model)) {
            throw new Error(`MEMORY_EMBED_MODEL must reference an embedding model, got "${this.model}"`);
        }
        if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
            throw new Error(`memory embedding dimensions must be a positive integer, got ${this.dimensions}`);
        }
        if (typeof this.apiKey === 'function') {
            this.validateCredentialConfiguration?.();
            return;
        }
        if (this.connection) {
            this.validateCredentialConfiguration?.();
            return;
        }
        if (!this.apiKey?.trim()) {
            throw new Error('Brokered Model Access is required for external memory embeddings');
        }
    }
    async resolveApiKey() {
        const apiKey = typeof this.apiKey === 'function' ? await this.apiKey() : this.apiKey;
        if (!apiKey?.trim()) {
            throw new Error('Brokered Model Access is required for external memory embeddings');
        }
        return apiKey;
    }
    async resolveBaseUrl() {
        const baseUrl = typeof this.baseUrl === 'function' ? await this.baseUrl() : this.baseUrl;
        const trimmed = baseUrl?.trim();
        if (!trimmed) {
            throw new Error('Brokered Model Access is required for external memory embeddings');
        }
        return trimmed.replace(/\/+$/, '');
    }
    async resolveConnection() {
        if (this.connection) {
            const connection = await this.connection();
            const apiKey = connection?.apiKey?.trim();
            const baseUrl = connection?.baseUrl?.trim();
            if (!connection || !apiKey || !baseUrl) {
                await connection?.revoke?.();
                throw new Error('Brokered Model Access is required for external memory embeddings');
            }
            const revoke = connection.revoke;
            return {
                apiKey,
                baseUrl: baseUrl.replace(/\/+$/, ''),
                ...(revoke ? { revoke } : {}),
            };
        }
        return {
            apiKey: await this.resolveApiKey(),
            baseUrl: await this.resolveBaseUrl(),
        };
    }
    async validateReady(_options) {
        this.validateConfiguration();
        if (typeof this.apiKey === 'function' || this.connection) {
            const connection = await this.resolveConnection();
            await connection.revoke?.();
        }
    }
    async embedMany(texts, options) {
        this.validateConfiguration();
        if (texts.length === 0)
            return [];
        const connection = await this.resolveConnection();
        try {
            const all = [];
            for (let i = 0; i < texts.length; i += MEMORY_EMBED_BATCH_SIZE) {
                const batch = texts.slice(i, i + MEMORY_EMBED_BATCH_SIZE);
                let res;
                try {
                    res = await fetch(`${connection.baseUrl}/v1/embeddings`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${connection.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        signal: options?.signal,
                        body: JSON.stringify({
                            model: this.model,
                            input: batch,
                            dimensions: this.dimensions,
                        }),
                    });
                }
                catch (error) {
                    if (options?.signal?.aborted)
                        throw error;
                    throw classifyEmbeddingThrown(error);
                }
                if (!res.ok) {
                    const text = await res.text();
                    throw classifyEmbeddingHttpError(res.status, text, res.headers);
                }
                const json = (await res.json());
                if (!Array.isArray(json.data) || json.data.length !== batch.length) {
                    throw new Error(`embedding response size mismatch: expected ${batch.length}, got ${json.data?.length ?? 0}`);
                }
                for (const row of json.data) {
                    if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
                        throw new Error('embedding response contained invalid embedding vector');
                    }
                    if (row.embedding.length !== this.dimensions) {
                        throw new EmbeddingProviderError('invalid_dimension', `model "${this.model}" returned ${row.embedding.length} dimensions, but Gantry semantic memory is configured for ${this.dimensions}`);
                    }
                    all.push(row.embedding);
                }
            }
            return all;
        }
        finally {
            await connection.revoke?.();
        }
    }
    async embedOne(text, options) {
        const rows = await this.embedMany([text], options);
        if (!rows[0]) {
            throw new Error('embedding response was empty');
        }
        return rows[0];
    }
    get batch() {
        return this;
    }
    async withConnection(fn) {
        this.validateConfiguration();
        const connection = await this.resolveConnection();
        try {
            return await fn(connection);
        }
        finally {
            await connection.revoke?.();
        }
    }
    async submitBatch(requests, options) {
        return this.withConnection((conn) => submitEmbeddingBatch(conn, { model: this.model, dimensions: this.dimensions, requests }, options?.signal));
    }
    async pollBatch(batchId, options) {
        return this.withConnection((conn) => pollEmbeddingBatch(conn, batchId, options?.signal));
    }
    async fetchBatchResults(poll, options) {
        return this.withConnection((conn) => fetchEmbeddingBatchResults(conn, poll, options?.signal));
    }
}
function validateBrokeredEmbeddingConfiguration() {
    const brokerConfig = getCredentialBrokerRuntimeConfig();
    if (brokerConfig.mode === 'gantry')
        return;
    throw new Error('Gantry Model Access is required for memory embeddings');
}
function validateEmbeddingProviderDefinition(providerId) {
    const provider = getModelProviderDefinition(providerId);
    if (!provider?.embeddingProvider) {
        throw new Error(`Model provider ${providerId} is not registered for memory embeddings.`);
    }
}
async function resolveBrokeredEmbeddingConnection(providerId, appId) {
    validateEmbeddingProviderDefinition(providerId);
    if (!appId) {
        throw new Error('Memory embeddings require an app-scoped credential binding.');
    }
    const brokerConfig = getCredentialBrokerRuntimeConfig();
    if (brokerConfig.mode !== 'gantry')
        return null;
    const configKey = `${brokerConfig.mode}:${brokerConfig.gatewayBindHost}`;
    if (embeddingCredentialBrokerConfigKey !== configKey) {
        void embeddingCredentialBrokerPromise
            ?.then((broker) => broker?.close?.())
            .catch((error) => {
            logger.warn({ err: error }, 'Failed to close replaced embedding credential broker');
        });
        embeddingCredentialBrokerPromise = undefined;
        embeddingCredentialBrokerConfigKey = configKey;
    }
    return resolveBrokeredEmbeddingInjectionFromBroker({
        mode: 'gantry',
        gatewayBindHost: brokerConfig.gatewayBindHost,
        providerId,
        appId,
    });
}
async function resolveBrokeredEmbeddingInjectionFromBroker(brokerConfig) {
    embeddingCredentialBrokerPromise ??= createAgentCredentialBroker({
        mode: brokerConfig.mode,
        modelCredentials: getRuntimeStorage().repositories.modelCredentials,
        gatewayBindHost: brokerConfig.gatewayBindHost,
        publishRuntimeEvent: (event) => getRuntimeStorage().runtimeEvents.publish(event),
    }).catch((error) => {
        embeddingCredentialBrokerPromise = undefined;
        throw error;
    });
    const broker = await embeddingCredentialBrokerPromise;
    if (!broker)
        return null;
    const providerId = normalizeModelProviderId(brokerConfig.providerId);
    const runId = `memory-embedding:${randomUUID()}`;
    const projection = getModelProviderDefinition(providerId)?.gateway.sdkProjection;
    if (!projection)
        return null;
    const injection = await getAgentCredentialInjection({
        mode: 'gantry',
        purpose: 'model_runtime',
        appId: brokerConfig.appId,
        runId,
        modelCredentialProviderId: providerId,
        broker,
    });
    return {
        apiKey: injection.env[projection.tokenEnv] ?? null,
        baseUrl: injection.env[projection.baseUrlEnv] ?? null,
        revoke: () => broker.revokeInjection?.({
            binding: {
                profile: 'gantry',
                purpose: 'model_runtime',
                appId: brokerConfig.appId,
                runId,
                modelCredentialProviderId: providerId,
            },
        }) ?? Promise.resolve(),
    };
}
export class DisabledEmbeddingClient {
    isEnabled() {
        return false;
    }
    validateConfiguration() {
        // Disabled provider intentionally requires no credentials.
    }
    async embedMany(texts, _options) {
        if (texts.length === 0)
            return [];
        throw new Error('memory embeddings are disabled');
    }
    async embedOne(_text, _options) {
        throw new Error('memory embeddings are disabled');
    }
}
function registerEmbeddingProvider(name, factory) {
    embeddingProviderFactories.set(name, factory);
}
export function isEmbeddingProviderRegistered(name) {
    return embeddingProviderFactories.has(name);
}
export function createEmbeddingProvider(providerName = MEMORY_EMBED_PROVIDER, options = {}) {
    const factory = embeddingProviderFactories.get(providerName);
    if (!factory) {
        throw new Error(`Unknown memory embedding provider "${providerName}". Registered providers: ${[...embeddingProviderFactories.keys()].join(', ') || 'none'}`);
    }
    return factory(options);
}
export async function validateEmbeddingProviderReady(providerName = MEMORY_EMBED_PROVIDER) {
    const provider = createEmbeddingProvider(providerName);
    provider.validateConfiguration();
    await provider.validateReady?.();
}
for (const provider of listEmbeddingModelProviders()) {
    registerEmbeddingProvider(provider.id, (options) => new OpenAIEmbeddingClient(null, options?.model || MEMORY_EMBED_MODEL, () => {
        validateBrokeredEmbeddingConfiguration();
        validateEmbeddingProviderDefinition(provider.id);
    }, DEFAULT_EMBEDDING_BASE_URL, () => resolveBrokeredEmbeddingConnection(provider.id, options?.appId), options?.dimensions ?? MEMORY_EMBED_DIMENSIONS));
}
const defaultEmbeddingProvider = getDefaultEmbeddingModelProvider();
if (defaultEmbeddingProvider &&
    defaultEmbeddingProvider.id !== OPEN_AI_PROVIDER_ALIAS) {
    registerEmbeddingProvider(OPEN_AI_PROVIDER_ALIAS, (options) => new OpenAIEmbeddingClient(null, options?.model || MEMORY_EMBED_MODEL, () => {
        validateBrokeredEmbeddingConfiguration();
        validateEmbeddingProviderDefinition(defaultEmbeddingProvider.id);
    }, DEFAULT_EMBEDDING_BASE_URL, () => resolveBrokeredEmbeddingConnection(defaultEmbeddingProvider.id, options?.appId), options?.dimensions ?? MEMORY_EMBED_DIMENSIONS));
}
registerEmbeddingProvider('disabled', () => new DisabledEmbeddingClient());
