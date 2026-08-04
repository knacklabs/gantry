import { DEFAULT_AGENT_ENGINE, DEEPAGENTS_ENGINE, } from './agent-engine.js';
import { OPENAI_COMPATIBLE_PROVIDER_DEFINITIONS } from './model-provider-registry-openai-compatible.js';
export const MODEL_PROVIDER_DEFINITIONS = [
    {
        id: 'anthropic',
        label: 'Anthropic',
        executable: true,
        modelRoute: true,
        embeddingProvider: false,
        batch: { supportedCredentialModes: ['api_key'] },
        responseFamily: 'anthropic',
        supportedWorkloads: [
            'chat',
            'one_time_job',
            'recurring_job',
            'memory_extractor',
            'memory_dreaming',
            'memory_consolidation',
        ],
        credentialModes: [
            {
                id: 'api_key',
                label: 'API key',
                helpText: 'Use an Anthropic account key for direct Anthropic access.',
                version: 1,
                fields: [
                    {
                        name: 'apiKey',
                        label: 'Anthropic key',
                        secret: true,
                        required: true,
                    },
                ],
                gatewayAuth: {
                    strategy: 'header',
                    field: 'apiKey',
                    headerName: 'x-api-key',
                },
            },
            {
                id: 'claude_code_oauth',
                label: 'Claude Code OAuth',
                helpText: 'Use a Claude Code OAuth token. Gantry stores it and uses it only inside the Model Gateway.',
                version: 1,
                fields: [
                    {
                        name: 'oauthToken',
                        label: 'Claude Code OAuth token',
                        secret: true,
                        required: true,
                    },
                ],
                gatewayAuth: {
                    strategy: 'claude_code_oauth',
                    field: 'oauthToken',
                },
            },
        ],
        gateway: {
            pathSegment: 'anthropic',
            upstreamOrigin: 'https://api.anthropic.com',
            upstreamPathPrefix: '',
            sdkProjection: {
                baseUrlEnv: 'ANTHROPIC_BASE_URL',
                tokenEnv: 'ANTHROPIC_API_KEY',
                credentialProviderEnvKey: 'ANTHROPIC_API_KEY',
                credentialProvider: 'native',
            },
        },
        cacheSupport: {
            prompt: {
                mode: 'anthropic_cache_control',
                automatic: false,
                requestControl: 'cache_control_blocks',
                ttlOptions: ['5m', '1h'],
                minimumTokenThresholds: [
                    { modelFamily: 'claude-opus-4.6+', tokens: 4096 },
                    { modelFamily: 'claude-sonnet-4.6', tokens: 2048 },
                    { modelFamily: 'claude-haiku-4.5', tokens: 4096 },
                ],
                usageFields: {
                    readTokens: 'cache_read_input_tokens',
                    writeTokens: 'cache_creation_input_tokens',
                },
            },
            response: {
                mode: 'none',
                enabledByDefault: false,
                requestControl: 'none',
                requestHeaders: [],
                responseHeaders: [],
                usageBehavior: 'normal_usage',
            },
        },
        // Claude is the Anthropic SDK lane: it is the only engine that supports
        // Claude OAuth/subscription, and it also serves Claude API-key.
        executionRoute: {
            engine: DEFAULT_AGENT_ENGINE,
            executionProviderId: 'anthropic:claude-agent-sdk',
            supportedCredentialModes: ['api_key', 'claude_code_oauth'],
        },
        sdkModelCapabilityMetadata: true,
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        executable: true,
        modelRoute: true,
        embeddingProvider: false,
        responseFamily: 'anthropic',
        supportedWorkloads: [
            'chat',
            'one_time_job',
            'recurring_job',
            'memory_extractor',
            'memory_dreaming',
            'memory_consolidation',
        ],
        credentialModes: [
            {
                id: 'api_key',
                label: 'API key',
                helpText: 'Use an OpenRouter key for Anthropic-compatible routing.',
                version: 1,
                fields: [
                    {
                        name: 'apiKey',
                        label: 'OpenRouter key',
                        secret: true,
                        required: true,
                    },
                ],
                gatewayAuth: {
                    strategy: 'bearer',
                    field: 'apiKey',
                },
            },
        ],
        gateway: {
            pathSegment: 'openrouter',
            upstreamOrigin: 'https://openrouter.ai',
            upstreamPathPrefix: '/api',
            // OpenRouter is the DeepAgents lane: it speaks chat/completions and
            // projects the same loopback base-url + gtw_ token under the deepagents
            // env names so ChatOpenRouter reads them. The upstream credential is still
            // a bearer OpenRouter key.
            sdkProjection: {
                baseUrlEnv: 'OPENAI_BASE_URL',
                tokenEnv: 'OPENAI_API_KEY',
                credentialProviderEnvKey: 'OPENAI_API_KEY',
                credentialProvider: 'openrouter',
            },
        },
        cacheSupport: {
            prompt: {
                // Via chat/completions the usage is prefix-shaped; Kimi/Moonshot caches
                // AUTOMATICALLY on the request prefix (no explicit cache_control
                // breakpoints), read/written off prompt_tokens_details.*.
                mode: 'openrouter_automatic_prefix',
                automatic: true,
                requestControl: 'provider_automatic_prefix',
                ttlOptions: ['5m', '1h'],
                minimumTokenThresholds: [
                    { modelFamily: 'anthropic-compatible', tokens: 2048 },
                ],
                usageFields: {
                    readTokens: 'prompt_tokens_details.cached_tokens',
                    writeTokens: 'prompt_tokens_details.cache_write_tokens',
                },
            },
            response: {
                mode: 'openrouter_response_cache',
                enabledByDefault: false,
                requestControl: 'request_header',
                requestHeaders: [
                    'X-OpenRouter-Cache',
                    'X-OpenRouter-Cache-TTL',
                    'X-OpenRouter-Cache-Clear',
                ],
                responseHeaders: [
                    'X-OpenRouter-Cache-Status',
                    'X-OpenRouter-Cache-Age',
                    'X-OpenRouter-Cache-TTL',
                ],
                usageBehavior: 'zero_usage_on_hit',
            },
        },
        // OpenRouter is the DeepAgents lane (was anthropic_sdk): the gateway
        // sdkProjection + cacheSupport above are the deepagents-lane projection so
        // ChatOpenRouter speaks chat/completions through the loopback gateway.
        executionRoute: {
            engine: DEEPAGENTS_ENGINE,
            executionProviderId: 'deepagents:langchain',
            supportedCredentialModes: ['api_key'],
        },
        supportsReasoningEffort: true,
    },
    {
        id: 'openai',
        label: 'OpenAI',
        executable: true,
        modelRoute: true,
        embeddingProvider: true,
        batch: { supportedCredentialModes: ['api_key'] },
        responseFamily: 'openai',
        supportedWorkloads: [
            'chat',
            'memory_extractor',
            'memory_dreaming',
            'memory_consolidation',
        ],
        credentialModes: [
            {
                id: 'api_key',
                label: 'API key',
                helpText: 'Use an OpenAI account key for OpenAI API access.',
                version: 1,
                fields: [
                    {
                        name: 'apiKey',
                        label: 'OpenAI key',
                        secret: true,
                        required: true,
                    },
                ],
                gatewayAuth: {
                    strategy: 'bearer',
                    field: 'apiKey',
                },
            },
        ],
        gateway: {
            pathSegment: 'openai',
            upstreamOrigin: 'https://api.openai.com',
            upstreamPathPrefix: '',
            sdkProjection: {
                baseUrlEnv: 'OPENAI_BASE_URL',
                tokenEnv: 'OPENAI_API_KEY',
                credentialProviderEnvKey: 'OPENAI_API_KEY',
                credentialProvider: 'native',
            },
        },
        cacheSupport: {
            prompt: {
                mode: 'openai_automatic_prefix',
                automatic: true,
                requestControl: 'provider_automatic_prefix',
                ttlOptions: [],
                minimumTokenThresholds: [{ modelFamily: 'openai', tokens: 1024 }],
                usageFields: {
                    readTokens: 'prompt_tokens_details.cached_tokens',
                },
            },
            response: {
                mode: 'none',
                enabledByDefault: false,
                requestControl: 'none',
                requestHeaders: [],
                responseHeaders: [],
                usageBehavior: 'normal_usage',
            },
        },
        executionRoute: {
            engine: DEEPAGENTS_ENGINE,
            executionProviderId: 'deepagents:langchain',
            supportedCredentialModes: ['api_key'],
        },
        supportsReasoningEffort: true,
    },
    // Additional OpenAI-chat-completions-compatible providers on the DeepAgents
    // engine. Defined in a sibling module to keep this file under its line
    // budget; spread here so the registry stays the single source of truth.
    ...OPENAI_COMPATIBLE_PROVIDER_DEFINITIONS,
];
const PROVIDER_BY_ID = indexProviderDefinitionsById(MODEL_PROVIDER_DEFINITIONS);
const PROVIDER_BY_GATEWAY_PATH = indexProviderDefinitionsByGatewayPath(MODEL_PROVIDER_DEFINITIONS);
const EXECUTABLE_MODEL_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter((provider) => provider.executable);
const MODEL_ROUTE_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter((provider) => provider.modelRoute);
const EMBEDDING_MODEL_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter((provider) => provider.embeddingProvider);
export function listModelProviderDefinitions() {
    return MODEL_PROVIDER_DEFINITIONS;
}
export function listExecutableModelProviders() {
    return EXECUTABLE_MODEL_PROVIDERS;
}
export function listModelRouteProviders() {
    return MODEL_ROUTE_PROVIDERS;
}
export function getDefaultModelRouteProvider() {
    return MODEL_ROUTE_PROVIDERS[0];
}
export function listEmbeddingModelProviders() {
    return EMBEDDING_MODEL_PROVIDERS;
}
export function getDefaultEmbeddingModelProvider() {
    return EMBEDDING_MODEL_PROVIDERS[0];
}
export function getModelProviderDefinition(providerId) {
    return PROVIDER_BY_ID.get(providerId.trim().toLowerCase());
}
export function getModelProviderByGatewayPath(pathSegment) {
    return PROVIDER_BY_GATEWAY_PATH.get(pathSegment.trim().toLowerCase());
}
export function normalizeModelProviderId(providerId) {
    const normalized = providerId.trim().toLowerCase();
    if (getModelProviderDefinition(normalized)) {
        return normalized;
    }
    throw new Error(`Model credential provider must be one of ${listExecutableModelProviders()
        .map((provider) => provider.id)
        .join(', ')}.`);
}
export function normalizeModelRouteProviderId(providerId) {
    const normalized = normalizeModelProviderId(providerId);
    const definition = getModelProviderDefinition(normalized);
    if (definition?.modelRoute)
        return normalized;
    throw new Error(`Model provider ${providerId} is not a model route.`);
}
export function normalizeModelCredentialPayload(input) {
    const provider = getModelProviderDefinition(normalizeModelProviderId(input.providerId));
    if (!provider) {
        throw new Error(`Unsupported model provider: ${input.providerId}`);
    }
    const mode = resolveModelCredentialMode(provider, input.authMode);
    if (!input.payload ||
        typeof input.payload !== 'object' ||
        Array.isArray(input.payload)) {
        throw new Error(`Credential payload is required for ${provider.id}.`);
    }
    const rawPayload = input.payload;
    const allowed = new Set(mode.fields.map((field) => field.name));
    for (const key of Object.keys(rawPayload)) {
        if (!allowed.has(key)) {
            throw new Error(`Credential field ${key} is not supported for ${provider.id} ${mode.id}.`);
        }
    }
    const payload = {};
    for (const field of mode.fields) {
        const value = rawPayload[field.name];
        if (typeof value === 'string' && value.trim()) {
            const normalized = value.trim();
            validateCredentialFieldValue(provider, mode.id, field.name, normalized);
            payload[field.name] = normalized;
            continue;
        }
        if (field.required) {
            throw new Error(`Credential field ${field.name} is required for ${provider.id} ${mode.id}.`);
        }
    }
    return payload;
}
export function normalizePartialModelCredentialPayload(input) {
    const provider = getModelProviderDefinition(normalizeModelProviderId(input.providerId));
    if (!provider) {
        throw new Error(`Unsupported model provider: ${input.providerId}`);
    }
    const mode = resolveModelCredentialMode(provider, input.authMode);
    if (!input.payload ||
        typeof input.payload !== 'object' ||
        Array.isArray(input.payload)) {
        throw new Error(`Credential payload is required for ${provider.id}.`);
    }
    const rawPayload = input.payload;
    const keys = Object.keys(rawPayload);
    if (keys.length === 0) {
        throw new Error(`Credential payload must include at least one field.`);
    }
    const allowed = new Set(mode.fields.map((field) => field.name));
    const payload = {};
    for (const key of keys) {
        if (!allowed.has(key)) {
            throw new Error(`Credential field ${key} is not supported for ${provider.id} ${mode.id}.`);
        }
        const value = rawPayload[key];
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`Credential field ${key} must be a non-empty string.`);
        }
        const normalized = value.trim();
        validateCredentialFieldValue(provider, mode.id, key, normalized);
        payload[key] = normalized;
    }
    return payload;
}
export function resolveModelCredentialMode(provider, authMode) {
    if (authMode?.trim()) {
        const normalized = authMode.trim();
        const mode = provider.credentialModes.find((item) => item.id === normalized);
        if (!mode) {
            throw new Error(`Credential auth mode ${normalized} is not supported for ${provider.id}.`);
        }
        return mode;
    }
    if (provider.credentialModes.length === 1)
        return provider.credentialModes[0];
    throw new Error(`Credential auth mode is required for ${provider.id}.`);
}
function indexProviderDefinitionsById(providers) {
    const indexed = new Map();
    for (const provider of providers) {
        if (indexed.has(provider.id)) {
            throw new Error(`Duplicate model provider id: ${provider.id}`);
        }
        indexed.set(provider.id, provider);
    }
    return indexed;
}
function indexProviderDefinitionsByGatewayPath(providers) {
    const indexed = new Map();
    for (const provider of providers) {
        const path = provider.gateway.pathSegment;
        if (indexed.has(path)) {
            throw new Error(`Duplicate model gateway path segment: ${path}`);
        }
        indexed.set(path, provider);
    }
    return indexed;
}
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/;
const GOOGLE_VERTEX_LOCATION_PATTERN = /^global$/;
const GOOGLE_PROJECT_PATTERN = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d{6,})$/;
const AWS_SECRET_MANAGER_REF_PATTERN = /^aws-sm:[^\r\n]+$/;
const GCP_SECRET_MANAGER_REF_PATTERN = /^gcp-sm:projects\/[^/\r\n]+\/(?:locations\/[^/\r\n]+\/)?secrets\/[^/\r\n]+\/versions\/[^/\r\n]+$/;
const CLOUD_PROFILE_PATTERN = /^[^\r\n]{1,256}$/;
const CREDENTIAL_FIELD_PATTERNS = {
    'bedrock:region': AWS_REGION_PATTERN,
    'bedrock:apiKeyRef': AWS_SECRET_MANAGER_REF_PATTERN,
    'bedrock:profile': CLOUD_PROFILE_PATTERN,
    'vertex:region': GOOGLE_VERTEX_LOCATION_PATTERN,
    'vertex:projectId': GOOGLE_PROJECT_PATTERN,
    'vertex:serviceAccountJsonRef': GCP_SECRET_MANAGER_REF_PATTERN,
};
function validateCredentialFieldValue(provider, modeId, field, value) {
    const pattern = CREDENTIAL_FIELD_PATTERNS[`${provider.id}:${field}`];
    if (pattern) {
        if (!pattern.test(value))
            throw invalidCredentialField(provider.id, modeId, field);
        return;
    }
    if (provider.id === 'vertex' && field === 'serviceAccountJson') {
        let parsed;
        try {
            parsed = JSON.parse(value);
        }
        catch {
            throw invalidCredentialField(provider.id, modeId, field);
        }
        if (!parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            parsed.type !== 'service_account' ||
            typeof parsed.project_id !== 'string' ||
            typeof parsed.client_email !== 'string' ||
            typeof parsed.private_key !== 'string') {
            throw invalidCredentialField(provider.id, modeId, field);
        }
    }
}
function invalidCredentialField(providerId, modeId, field) {
    return new Error(`Credential field ${field} is invalid for ${providerId} ${modeId}.`);
}
