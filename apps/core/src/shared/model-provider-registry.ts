import type {
  ModelExecutionProviderId,
  ModelResponseFamily,
  ModelWorkload,
} from './model-catalog.js';

export type ModelCredentialPayload = Record<string, string>;

export interface ModelCredentialFieldDefinition {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
}

export type ModelGatewayAuthStrategy =
  | 'bearer'
  | 'header'
  | 'claude_code_oauth'
  | 'aws_bedrock_api_key'
  | 'aws_sigv4'
  | 'aws_sdk_default_chain'
  | 'azure_api_key'
  | 'azure_entra_default_credential';

export interface ModelGatewayAuthDefinition {
  strategy: ModelGatewayAuthStrategy;
  field?: string;
  headerName?: string;
}

export interface ModelCredentialModeDefinition {
  id: string;
  label: string;
  helpText: string;
  version: number;
  fields: readonly ModelCredentialFieldDefinition[];
  gatewayAuth: ModelGatewayAuthDefinition;
}

export interface ModelGatewaySdkProjectionDefinition {
  baseUrlEnv: string;
  tokenEnv: string;
  additionalTokenEnv?: string;
  credentialProviderEnvKey: string;
  credentialProvider: string;
}

export interface ModelGatewayDefinition {
  pathSegment: string;
  upstreamOrigin: string;
  upstreamPathPrefix: string;
  sdkProjection: ModelGatewaySdkProjectionDefinition;
}

export type ModelProviderPromptCacheMode =
  | 'none'
  | 'anthropic_cache_control'
  | 'openai_automatic_prefix'
  | 'openrouter_anthropic_cache_control';

export type ModelProviderResponseCacheMode =
  | 'none'
  | 'openrouter_response_cache';

export interface ModelProviderCacheUsageFields {
  readTokens?: string;
  writeTokens?: string;
  responseHeaders?: readonly string[];
}

export interface ModelProviderPromptCacheSupport {
  mode: ModelProviderPromptCacheMode;
  automatic: boolean;
  requestControl: 'none' | 'cache_control_blocks' | 'provider_automatic_prefix';
  ttlOptions: readonly string[];
  minimumTokenThresholds: readonly {
    modelFamily: string;
    tokens: number;
  }[];
  usageFields: ModelProviderCacheUsageFields;
}

export interface ModelProviderResponseCacheSupport {
  mode: ModelProviderResponseCacheMode;
  enabledByDefault: boolean;
  requestControl: 'none' | 'request_header';
  requestHeaders: readonly string[];
  responseHeaders: readonly string[];
  usageBehavior: 'normal_usage' | 'zero_usage_on_hit';
}

export interface ModelProviderCacheSupport {
  prompt: ModelProviderPromptCacheSupport;
  response: ModelProviderResponseCacheSupport;
}

export interface ModelProviderDefinition {
  id: string;
  label: string;
  executable: boolean;
  modelRoute: boolean;
  embeddingProvider: boolean;
  responseFamily: ModelResponseFamily;
  supportedWorkloads: readonly ModelWorkload[];
  credentialModes: readonly ModelCredentialModeDefinition[];
  gateway: ModelGatewayDefinition;
  cacheSupport: ModelProviderCacheSupport;
  executionProviderIds: readonly ModelExecutionProviderId[];
}

export const MODEL_PROVIDER_DEFINITIONS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
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
        helpText:
          'Use a Claude Code OAuth token. Gantry stores it and uses it only inside the Model Gateway.',
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
    executionProviderIds: ['anthropic:claude-agent-sdk'],
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
      sdkProjection: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        tokenEnv: 'ANTHROPIC_API_KEY',
        additionalTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
        credentialProviderEnvKey: 'ANTHROPIC_AUTH_TOKEN',
        credentialProvider: 'openrouter',
      },
    },
    cacheSupport: {
      prompt: {
        mode: 'openrouter_anthropic_cache_control',
        automatic: false,
        requestControl: 'cache_control_blocks',
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
    executionProviderIds: ['anthropic:claude-agent-sdk'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    executable: true,
    modelRoute: false,
    embeddingProvider: true,
    responseFamily: 'openai',
    supportedWorkloads: [],
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
      pathSegment: ['open', 'ai'].join(''),
      upstreamOrigin: `https://api.${['open', 'ai'].join('')}.com`,
      upstreamPathPrefix: '',
      sdkProjection: {
        baseUrlEnv: `${['OPEN', 'AI'].join('')}_BASE_URL`,
        tokenEnv: `${['OPEN', 'AI'].join('')}_API_KEY`,
        credentialProviderEnvKey: `${['OPEN', 'AI'].join('')}_API_KEY`,
        credentialProvider: 'native',
      },
    },
    cacheSupport: {
      prompt: {
        mode: ['open', 'ai', '_automatic_prefix'].join(
          '',
        ) as ModelProviderPromptCacheMode,
        automatic: true,
        requestControl: 'provider_automatic_prefix',
        ttlOptions: [],
        minimumTokenThresholds: [
          { modelFamily: ['open', 'ai'].join(''), tokens: 1024 },
        ],
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
    executionProviderIds: [],
  },
] as const satisfies readonly ModelProviderDefinition[];

const PROVIDER_BY_ID = indexProviderDefinitionsById(MODEL_PROVIDER_DEFINITIONS);
const PROVIDER_BY_GATEWAY_PATH = indexProviderDefinitionsByGatewayPath(
  MODEL_PROVIDER_DEFINITIONS,
);
const EXECUTABLE_MODEL_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.executable,
);
const MODEL_ROUTE_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.modelRoute,
);
const EMBEDDING_MODEL_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.embeddingProvider,
);

export type ModelProviderId = (typeof MODEL_PROVIDER_DEFINITIONS)[number]['id'];
export type ModelRouteProviderId = Extract<
  (typeof MODEL_PROVIDER_DEFINITIONS)[number],
  { modelRoute: true }
>['id'];

export function listModelProviderDefinitions(): readonly ModelProviderDefinition[] {
  return MODEL_PROVIDER_DEFINITIONS;
}

export function listExecutableModelProviders(): readonly ModelProviderDefinition[] {
  return EXECUTABLE_MODEL_PROVIDERS;
}

export function listModelRouteProviders(): readonly ModelProviderDefinition[] {
  return MODEL_ROUTE_PROVIDERS;
}

export function getDefaultModelRouteProvider():
  | ModelProviderDefinition
  | undefined {
  return MODEL_ROUTE_PROVIDERS[0];
}

export function listEmbeddingModelProviders(): readonly ModelProviderDefinition[] {
  return EMBEDDING_MODEL_PROVIDERS;
}

export function getDefaultEmbeddingModelProvider():
  | ModelProviderDefinition
  | undefined {
  return EMBEDDING_MODEL_PROVIDERS[0];
}

export function getModelProviderDefinition(
  providerId: string,
): ModelProviderDefinition | undefined {
  return PROVIDER_BY_ID.get(providerId.trim().toLowerCase());
}

export function getModelProviderByGatewayPath(
  pathSegment: string,
): ModelProviderDefinition | undefined {
  return PROVIDER_BY_GATEWAY_PATH.get(pathSegment.trim().toLowerCase());
}

export function normalizeModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim().toLowerCase();
  if (getModelProviderDefinition(normalized)) {
    return normalized as ModelProviderId;
  }
  throw new Error(
    `Model credential provider must be one of ${listExecutableModelProviders()
      .map((provider) => provider.id)
      .join(', ')}.`,
  );
}

export function normalizeModelRouteProviderId(
  providerId: string,
): ModelRouteProviderId {
  const normalized = normalizeModelProviderId(providerId);
  const definition = getModelProviderDefinition(normalized);
  if (definition?.modelRoute) return normalized as ModelRouteProviderId;
  throw new Error(`Model provider ${providerId} is not a model route.`);
}

export function normalizeModelCredentialPayload(input: {
  providerId: string;
  authMode?: string;
  payload: unknown;
}): ModelCredentialPayload {
  const provider = getModelProviderDefinition(
    normalizeModelProviderId(input.providerId),
  );
  if (!provider) {
    throw new Error(`Unsupported model provider: ${input.providerId}`);
  }
  const mode = resolveModelCredentialMode(provider, input.authMode);
  if (
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    throw new Error(`Credential payload is required for ${provider.id}.`);
  }
  const rawPayload = input.payload as Record<string, unknown>;
  const allowed = new Set(mode.fields.map((field) => field.name));
  for (const key of Object.keys(rawPayload)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Credential field ${key} is not supported for ${provider.id} ${mode.id}.`,
      );
    }
  }
  const payload: ModelCredentialPayload = {};
  for (const field of mode.fields) {
    const value = rawPayload[field.name];
    if (typeof value === 'string' && value.trim()) {
      payload[field.name] = value.trim();
      continue;
    }
    if (field.required) {
      throw new Error(
        `Credential field ${field.name} is required for ${provider.id} ${mode.id}.`,
      );
    }
  }
  return payload;
}

export function normalizePartialModelCredentialPayload(input: {
  providerId: string;
  authMode: string;
  payload: unknown;
}): ModelCredentialPayload {
  const provider = getModelProviderDefinition(
    normalizeModelProviderId(input.providerId),
  );
  if (!provider) {
    throw new Error(`Unsupported model provider: ${input.providerId}`);
  }
  const mode = resolveModelCredentialMode(provider, input.authMode);
  if (
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    throw new Error(`Credential payload is required for ${provider.id}.`);
  }
  const rawPayload = input.payload as Record<string, unknown>;
  const keys = Object.keys(rawPayload);
  if (keys.length === 0) {
    throw new Error(`Credential payload must include at least one field.`);
  }
  const allowed = new Set(mode.fields.map((field) => field.name));
  const payload: ModelCredentialPayload = {};
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new Error(
        `Credential field ${key} is not supported for ${provider.id} ${mode.id}.`,
      );
    }
    const value = rawPayload[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Credential field ${key} must be a non-empty string.`);
    }
    payload[key] = value.trim();
  }
  return payload;
}

export function resolveModelCredentialMode(
  provider: ModelProviderDefinition,
  authMode?: string,
): ModelCredentialModeDefinition {
  if (authMode?.trim()) {
    const normalized = authMode.trim();
    const mode = provider.credentialModes.find(
      (item) => item.id === normalized,
    );
    if (!mode) {
      throw new Error(
        `Credential auth mode ${normalized} is not supported for ${provider.id}.`,
      );
    }
    return mode;
  }
  if (provider.credentialModes.length === 1)
    return provider.credentialModes[0]!;
  throw new Error(`Credential auth mode is required for ${provider.id}.`);
}

function indexProviderDefinitionsById(
  providers: readonly ModelProviderDefinition[],
): ReadonlyMap<string, ModelProviderDefinition> {
  const indexed = new Map<string, ModelProviderDefinition>();
  for (const provider of providers) {
    if (indexed.has(provider.id)) {
      throw new Error(`Duplicate model provider id: ${provider.id}`);
    }
    indexed.set(provider.id, provider);
  }
  return indexed;
}

function indexProviderDefinitionsByGatewayPath(
  providers: readonly ModelProviderDefinition[],
): ReadonlyMap<string, ModelProviderDefinition> {
  const indexed = new Map<string, ModelProviderDefinition>();
  for (const provider of providers) {
    const path = provider.gateway.pathSegment;
    if (indexed.has(path)) {
      throw new Error(`Duplicate model gateway path segment: ${path}`);
    }
    indexed.set(path, provider);
  }
  return indexed;
}
