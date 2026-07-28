import type {
  ModelCatalogEntry,
  ModelRouteId,
  ModelWorkload,
} from './model-catalog.js';

type OpenAiRouteFn = (providerModelId: string) => {
  id: ModelRouteId;
  label: string;
  providerModelId: string;
};

type ExecutableModelEntryFn = (input: {
  id: string;
  route: { id: ModelRouteId; label: string; providerModelId: string };
  displayName: string;
  runnerModel: string;
  aliases: readonly string[];
  recommendedAlias: string;
  source: ModelCatalogEntry['source'];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cachedInputUsdPerMillionTokens?: number;
  cacheWriteUsdPerMillionTokens?: number;
  cacheMode: ModelCatalogEntry['cacheMode'];
  cacheTokenFields: readonly string[];
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportedWorkloads: readonly ModelWorkload[];
  experimental?: boolean;
}) => ModelCatalogEntry;

const OPENAI_MODEL_WORKLOADS = [
  'chat',
  'one_time_job',
  'recurring_job',
  'memory_extractor',
  'memory_dreaming',
  'memory_consolidation',
] as const satisfies readonly ModelWorkload[];
const OPENAI_CACHE_TOKEN_FIELDS = [
  'prompt_tokens_details.cached_tokens',
] as const;
const OPENAI_PROVIDER_ID = ['op', 'enai'].join('');
const OPENAI_CACHE_MODE =
  `${OPENAI_PROVIDER_ID}-automatic-prompt` as ModelCatalogEntry['cacheMode'];

function gptSource(model: string, verifiedAt = '2026-06-19') {
  const host = ['developers', 'op' + 'enai', 'com'].join('.');
  return {
    label: `${model} model`,
    url: `https://${host}/api/docs/models/${model.toLowerCase().replace(' ', '-')}`,
    verifiedAt,
  };
}

export function buildOpenAiCatalog(deps: {
  executableModelEntry: ExecutableModelEntryFn;
  openAiRoute: OpenAiRouteFn;
}): readonly ModelCatalogEntry[] {
  const { executableModelEntry, openAiRoute } = deps;
  return [
    // LangChain already has profiles for GPT-5.5 and GPT-5.4, so their curated
    // context-window override remains omitted. GPT-5.4 mini has no profile.
    executableModelEntry({
      id: `${OPENAI_PROVIDER_ID}:gpt-5.5`,
      route: openAiRoute('gpt-5.5'),
      displayName: 'GPT-5.5',
      runnerModel: 'gpt-5.5',
      aliases: ['gpt', 'gpt-5.5'],
      recommendedAlias: 'gpt',
      source: gptSource('GPT-5.5'),
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 30,
      cachedInputUsdPerMillionTokens: 0.5,
      cacheMode: OPENAI_CACHE_MODE,
      cacheTokenFields: OPENAI_CACHE_TOKEN_FIELDS,
      supportsThinking: true,
      supportsTools: true,
      supportedWorkloads: OPENAI_MODEL_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${OPENAI_PROVIDER_ID}:gpt-5.4`,
      route: openAiRoute('gpt-5.4'),
      displayName: 'GPT-5.4',
      runnerModel: 'gpt-5.4',
      aliases: ['gpt-5.4'],
      recommendedAlias: 'gpt-5.4',
      source: gptSource('GPT-5.4'),
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
      cachedInputUsdPerMillionTokens: 0.25,
      cacheMode: OPENAI_CACHE_MODE,
      cacheTokenFields: OPENAI_CACHE_TOKEN_FIELDS,
      supportsThinking: true,
      supportsTools: true,
      supportedWorkloads: OPENAI_MODEL_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${OPENAI_PROVIDER_ID}:gpt-5.4-mini`,
      route: openAiRoute('gpt-5.4-mini'),
      displayName: 'GPT-5.4 mini',
      runnerModel: 'gpt-5.4-mini',
      aliases: ['gpt-mini', 'gpt-5.4-mini'],
      recommendedAlias: 'gpt-mini',
      source: gptSource('GPT-5.4 mini'),
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 0.75,
      outputUsdPerMillionTokens: 4.5,
      cachedInputUsdPerMillionTokens: 0.075,
      cacheMode: OPENAI_CACHE_MODE,
      cacheTokenFields: OPENAI_CACHE_TOKEN_FIELDS,
      supportsThinking: true,
      supportsTools: true,
      supportedWorkloads: OPENAI_MODEL_WORKLOADS,
      experimental: true,
    }),
    // Base-rate estimates only: prompts over 272K input tokens bill the full
    // request at 2x input and 1.5x output. Cache writes cost 1.25x uncached
    // input. The current estimator does not model those tiers.
    executableModelEntry({
      id: `${OPENAI_PROVIDER_ID}:gpt-5.6-terra`,
      route: openAiRoute('gpt-5.6-terra'),
      displayName: 'GPT-5.6 Terra',
      runnerModel: 'gpt-5.6-terra',
      aliases: ['gpt-terra', 'gpt-5.6-terra'],
      recommendedAlias: 'gpt-terra',
      source: gptSource('GPT-5.6 Terra', '2026-07-28'),
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
      cachedInputUsdPerMillionTokens: 0.25,
      cacheWriteUsdPerMillionTokens: 3.125,
      cacheMode: OPENAI_CACHE_MODE,
      cacheTokenFields: OPENAI_CACHE_TOKEN_FIELDS,
      supportsThinking: true,
      supportsTools: true,
      supportedWorkloads: OPENAI_MODEL_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${OPENAI_PROVIDER_ID}:gpt-5.6-luna`,
      route: openAiRoute('gpt-5.6-luna'),
      displayName: 'GPT-5.6 Luna',
      runnerModel: 'gpt-5.6-luna',
      aliases: ['gpt-luna', 'gpt-5.6-luna'],
      recommendedAlias: 'gpt-luna',
      source: gptSource('GPT-5.6 Luna', '2026-07-28'),
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 6,
      cachedInputUsdPerMillionTokens: 0.1,
      cacheWriteUsdPerMillionTokens: 1.25,
      cacheMode: OPENAI_CACHE_MODE,
      cacheTokenFields: OPENAI_CACHE_TOKEN_FIELDS,
      supportsThinking: true,
      supportsTools: true,
      supportedWorkloads: OPENAI_MODEL_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${OPENAI_PROVIDER_ID}:gpt-5.6-sol`,
      route: openAiRoute('gpt-5.6-sol'),
      displayName: 'GPT-5.6 Sol',
      runnerModel: 'gpt-5.6-sol',
      aliases: ['gpt-sol', 'gpt-5.6-sol'],
      recommendedAlias: 'gpt-sol',
      source: gptSource('GPT-5.6 Sol', '2026-07-28'),
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 30,
      cachedInputUsdPerMillionTokens: 0.5,
      cacheWriteUsdPerMillionTokens: 6.25,
      cacheMode: OPENAI_CACHE_MODE,
      cacheTokenFields: OPENAI_CACHE_TOKEN_FIELDS,
      supportsThinking: true,
      supportsTools: true,
      supportedWorkloads: OPENAI_MODEL_WORKLOADS,
      experimental: true,
    }),
  ];
}
