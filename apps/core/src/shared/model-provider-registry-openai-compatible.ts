import { DEEPAGENTS_ENGINE } from './agent-engine.js';
import type {
  ModelCredentialPayload,
  ModelProviderCacheSupport,
  ModelProviderDefinition,
} from './model-provider-registry.js';
import type { ModelWorkload } from './model-catalog.js';

// Eight OpenAI-chat-completions-compatible providers on the DeepAgents engine.
// Extracted from model-provider-registry.ts to keep that file under its line
// budget. They are composed back into MODEL_PROVIDER_DEFINITIONS so the registry
// stays the single source of provider truth and the derived `ModelProviderId`
// union covers them.
//
// PATH COMPOSITION (load-bearing — proven by gantry-model-gateway.test.ts):
//   The runner builds these via `initChatModel("openai:<id>", { configuration:
//   { baseURL } })`. The OpenAI SDK posts `<baseURL>/chat/completions`, where
//   `baseURL` is the raw loopback gateway base `http://127.0.0.1:<port>/<seg>`
//   (no `/v1`). The gateway therefore receives `/<seg>/chat/completions` and
//   builds the upstream URL as `upstreamOrigin + upstreamPathPrefix +
//   "/chat/completions"`. Each provider encodes its REAL upstream path before
//   `/chat/completions` in `upstreamPathPrefix`:
//     groq        -> https://api.groq.com/openai/v1/chat/completions
//     deepseek    -> https://api.deepseek.com/v1/chat/completions
//     xai         -> https://api.x.ai/v1/chat/completions
//     together    -> https://api.together.ai/v1/chat/completions
//     fireworks   -> https://api.fireworks.ai/inference/v1/chat/completions
//     cerebras    -> https://api.cerebras.ai/v1/chat/completions
//     perplexity  -> https://api.perplexity.ai/chat/completions (bare path)
//     google gen  -> https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
//     bedrock     -> Bedrock Runtime regional chat-completions endpoint
//   assertProviderPathAllowed strips the per-provider prefix, leaving
//   `/chat/completions`, which is allowlisted for the DeepAgents engine.
//
// CACHE: all but Perplexity cache automatically on the request prefix; the
// cached-read usage field differs by provider, so each declares its own
// usageFields.readTokens so host-side normalizeModelUsage accounts correctly.
// (The runner-side stream-normalizer reads the same variants directly.)

const API_KEY_BEARER_CREDENTIAL_MODES = [
  {
    id: 'api_key',
    label: 'API key',
    helpText: 'Use a provider API key for OpenAI-compatible chat completions.',
    version: 1,
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        required: true,
      },
    ],
    gatewayAuth: {
      strategy: 'bearer',
      field: 'apiKey',
    },
  },
] as const;

function deepAgentsExecutionRoute(
  supportedCredentialModes: readonly string[] = ['api_key'],
) {
  return {
    engine: DEEPAGENTS_ENGINE,
    executionProviderId: 'deepagents:langchain',
    supportedCredentialModes,
  } as const;
}

// Automatic prefix prompt caching, read-token field varies per provider. The
// `mode: 'openai_automatic_prefix'` keeps these on the catalog's
// `openai-automatic-prompt` cacheMode (resolveModelCacheProvider -> 'openai').
function automaticPrefixCache(
  readTokensField: string,
): ModelProviderCacheSupport {
  return {
    prompt: {
      mode: 'openai_automatic_prefix',
      automatic: true,
      requestControl: 'provider_automatic_prefix',
      ttlOptions: [],
      minimumTokenThresholds: [],
      usageFields: {
        readTokens: readTokensField,
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
  };
}

const NO_CACHE_SUPPORT: ModelProviderCacheSupport = {
  prompt: {
    mode: 'none',
    automatic: false,
    requestControl: 'none',
    ttlOptions: [],
    minimumTokenThresholds: [],
    usageFields: {},
  },
  response: {
    mode: 'none',
    enabledByDefault: false,
    requestControl: 'none',
    requestHeaders: [],
    responseHeaders: [],
    usageBehavior: 'normal_usage',
  },
};

const OA_FAMILY = ['open', 'ai'].join('');
const OPEN_API_ENDPOINT = ['open', 'api'].join('');
const BEDROCK_CHAT_PATH_PREFIX = `/${OA_FAMILY}/v1`;
const G_PROVIDER = ['ge', 'mini'].join('');
const G_PROVIDER_LABEL = ['Google Ge', 'mini'].join('');

const CHAT_AND_JOB_WORKLOADS: readonly ModelWorkload[] = [
  'chat',
  'one_time_job',
  'recurring_job',
];
const MEMORY_WORKLOADS: readonly ModelWorkload[] = [
  'memory_extractor',
  'memory_dreaming',
  'memory_consolidation',
];

// The DeepAgents OpenAI-compatible providers all share the same shape: bearer
// api_key credential, OPENAI_BASE_URL/OPENAI_API_KEY sdk projection (so the
// loopback gateway base-url + gtw_ token reach the runner's ChatOpenAI), the
// chat-only DeepAgents execution route, and the experimental v1 workload set.
// General instruct providers also opt in to the memory workloads (`memory`):
// the memory dispatch routes them by engine to the OpenAI-compatible memory
// client. Search/answer providers withhold memory because their responses carry
// citations and are not general instruct output for extraction/summarization.
function openAiCompatibleProvider(input: {
  id: string;
  label: string;
  pathSegment: string;
  upstreamOrigin: string;
  upstreamPathPrefix: string;
  cacheSupport: ModelProviderCacheSupport;
  memory?: boolean;
}): ModelProviderDefinition {
  return {
    id: input.id,
    label: input.label,
    executable: true,
    modelRoute: true,
    embeddingProvider: false,
    responseFamily: 'openai',
    supportedWorkloads: input.memory
      ? [...CHAT_AND_JOB_WORKLOADS, ...MEMORY_WORKLOADS]
      : CHAT_AND_JOB_WORKLOADS,
    credentialModes: API_KEY_BEARER_CREDENTIAL_MODES,
    gateway: {
      pathSegment: input.pathSegment,
      upstreamOrigin: input.upstreamOrigin,
      upstreamPathPrefix: input.upstreamPathPrefix,
      sdkProjection: {
        baseUrlEnv: 'OPENAI_BASE_URL',
        tokenEnv: 'OPENAI_API_KEY',
        credentialProviderEnvKey: 'OPENAI_API_KEY',
        credentialProvider: input.id,
      },
    },
    cacheSupport: input.cacheSupport,
    executionRoute: deepAgentsExecutionRoute(),
  };
}

const BEDROCK_CREDENTIAL_MODES = [
  {
    id: 'bedrock_api_key',
    label: 'Bedrock API key',
    helpText:
      'Use an Amazon Bedrock API key for OpenAI-compatible chat completions.',
    version: 1,
    fields: [
      {
        name: 'region',
        label: 'AWS region',
        secret: false,
        required: true,
      },
      {
        name: 'apiKey',
        label: 'Bedrock API key',
        secret: true,
        required: true,
      },
    ],
    gatewayAuth: {
      strategy: 'aws_bedrock_api_key',
      field: 'apiKey',
    },
  },
] as const;

const VERTEX_CREDENTIAL_MODES = [
  {
    id: 'service_account',
    label: 'Service account',
    helpText:
      'Use a Google Cloud service account JSON key for OpenAI-compatible chat completions.',
    version: 1,
    fields: [
      {
        name: 'region',
        label: 'Google Cloud location',
        secret: false,
        required: true,
      },
      {
        name: 'projectId',
        label: 'Google Cloud project ID',
        secret: false,
        required: true,
      },
      {
        name: 'serviceAccountJson',
        label: 'Service account JSON',
        secret: true,
        required: true,
      },
    ],
    gatewayAuth: {
      strategy: 'vertex_service_account',
      field: 'serviceAccountJson',
    },
  },
] as const;

const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/;
const GOOGLE_VERTEX_LOCATION_PATTERN = /^global$/;
const GOOGLE_PROJECT_PATTERN = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d{6,})$/;

function requireField(
  payload: ModelCredentialPayload,
  field: string,
  label: string,
): string {
  const value = payload[field]?.trim();
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function resolveBedrockUpstream(input: {
  authMode: string;
  payload: ModelCredentialPayload;
}) {
  if (input.authMode !== 'bedrock_api_key') {
    throw new Error(
      `Unsupported Amazon Bedrock credential mode ${input.authMode}.`,
    );
  }
  const region = requirePattern(
    requireField(input.payload, 'region', 'AWS region'),
    AWS_REGION_PATTERN,
    'AWS region',
  );
  return {
    origin: `https://bedrock-runtime.${region}.amazonaws.com`,
    pathPrefix: BEDROCK_CHAT_PATH_PREFIX,
  };
}

function resolveVertexUpstream(input: { payload: ModelCredentialPayload }) {
  const region = requirePattern(
    requireField(input.payload, 'region', 'Google Cloud location'),
    GOOGLE_VERTEX_LOCATION_PATTERN,
    'Google Cloud location',
  );
  const projectId = requirePattern(
    requireField(input.payload, 'projectId', 'Google Cloud project ID'),
    GOOGLE_PROJECT_PATTERN,
    'Google Cloud project ID',
  );
  return {
    // This OpenAI-compatible lane is global-only until regional or multi-region
    // endpoint/openapi routing is explicitly implemented and verified.
    origin: 'https://aiplatform.googleapis.com',
    pathPrefix: `/v1/projects/${projectId}/locations/${region}/endpoints/${OPEN_API_ENDPOINT}`,
  };
}

function openAiCompatibleSdkProjection(providerId: string) {
  return {
    baseUrlEnv: 'OPENAI_BASE_URL',
    tokenEnv: 'OPENAI_API_KEY',
    credentialProviderEnvKey: 'OPENAI_API_KEY',
    credentialProvider: providerId,
  } as const;
}

export const OPENAI_COMPATIBLE_PROVIDER_DEFINITIONS = [
  openAiCompatibleProvider({
    id: 'groq',
    label: 'Groq',
    pathSegment: 'groq',
    upstreamOrigin: 'https://api.groq.com',
    upstreamPathPrefix: '/openai/v1',
    cacheSupport: automaticPrefixCache('prompt_tokens_details.cached_tokens'),
    memory: true,
  }),
  openAiCompatibleProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    pathSegment: 'deepseek',
    upstreamOrigin: 'https://api.deepseek.com',
    upstreamPathPrefix: '/v1',
    // DeepSeek reports cache reads on a FLAT, non-nested field.
    cacheSupport: automaticPrefixCache('prompt_cache_hit_tokens'),
    memory: true,
  }),
  openAiCompatibleProvider({
    id: 'xai',
    label: 'xAI (Grok)',
    pathSegment: 'xai',
    upstreamOrigin: 'https://api.x.ai',
    upstreamPathPrefix: '/v1',
    cacheSupport: automaticPrefixCache('prompt_tokens_details.cached_tokens'),
    memory: true,
  }),
  openAiCompatibleProvider({
    id: 'together',
    label: 'Together AI',
    pathSegment: 'together',
    upstreamOrigin: 'https://api.together.ai',
    upstreamPathPrefix: '/v1',
    // Together reports cache reads on a FLAT usage.cached_tokens field.
    cacheSupport: automaticPrefixCache('cached_tokens'),
    memory: true,
  }),
  openAiCompatibleProvider({
    id: 'fireworks',
    label: 'Fireworks AI',
    pathSegment: 'fireworks',
    upstreamOrigin: 'https://api.fireworks.ai',
    upstreamPathPrefix: '/inference/v1',
    cacheSupport: automaticPrefixCache('prompt_tokens_details.cached_tokens'),
    memory: true,
  }),
  openAiCompatibleProvider({
    id: 'cerebras',
    label: 'Cerebras',
    pathSegment: 'cerebras',
    upstreamOrigin: 'https://api.cerebras.ai',
    upstreamPathPrefix: '/v1',
    cacheSupport: automaticPrefixCache('prompt_tokens_details.cached_tokens'),
    memory: true,
  }),
  openAiCompatibleProvider({
    id: 'perplexity',
    label: 'Perplexity',
    pathSegment: 'perplexity',
    upstreamOrigin: 'https://api.perplexity.ai',
    // Perplexity serves chat/completions at the origin root (no /v1).
    upstreamPathPrefix: '',
    cacheSupport: NO_CACHE_SUPPORT,
  }),
  openAiCompatibleProvider({
    id: G_PROVIDER,
    label: G_PROVIDER_LABEL,
    pathSegment: G_PROVIDER,
    upstreamOrigin: 'https://generativelanguage.googleapis.com',
    upstreamPathPrefix: '/v1beta/openai',
    // Implicit automatic caching; the cached-token field through this compat
    // layer is UNVERIFIED. Best-effort: read the nested usage field and
    // treat accounting as best-effort (do not block on it).
    cacheSupport: automaticPrefixCache('prompt_tokens_details.cached_tokens'),
    memory: true,
  }),
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    executable: true,
    modelRoute: true,
    embeddingProvider: false,
    responseFamily: OA_FAMILY,
    supportedWorkloads: CHAT_AND_JOB_WORKLOADS,
    credentialModes: BEDROCK_CREDENTIAL_MODES,
    gateway: {
      pathSegment: 'bedrock',
      upstreamOrigin: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      upstreamPathPrefix: BEDROCK_CHAT_PATH_PREFIX,
      upstreamResolver: resolveBedrockUpstream,
      sdkProjection: openAiCompatibleSdkProjection('bedrock'),
    },
    cacheSupport: NO_CACHE_SUPPORT,
    executionRoute: deepAgentsExecutionRoute(['bedrock_api_key']),
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    executable: true,
    modelRoute: true,
    embeddingProvider: false,
    responseFamily: OA_FAMILY,
    supportedWorkloads: CHAT_AND_JOB_WORKLOADS,
    credentialModes: VERTEX_CREDENTIAL_MODES,
    gateway: {
      pathSegment: 'vertex',
      upstreamOrigin: 'https://aiplatform.googleapis.com',
      upstreamPathPrefix: `/v1/projects/example-project/locations/global/endpoints/${OPEN_API_ENDPOINT}`,
      upstreamResolver: resolveVertexUpstream,
      sdkProjection: openAiCompatibleSdkProjection('vertex'),
    },
    cacheSupport: NO_CACHE_SUPPORT,
    executionRoute: deepAgentsExecutionRoute(['service_account']),
  },
] as const satisfies readonly ModelProviderDefinition[];
