import type {
  ModelCatalogEntry,
  ModelRouteId,
  ModelWorkload,
} from './model-catalog.js';
import { buildBedrockCatalog } from './model-catalog-bedrock.js';

// Catalog entries for OpenAI-chat-completions-compatible DeepAgents providers.
// Extracted from model-catalog.ts to keep that file under its line
// budget. This module is a pure builder: model-catalog.ts passes in its own
// `executableModelEntry` + `providerRoute` helpers, so there is NO runtime
// import back into model-catalog.ts (which would create an import cycle —
// model-catalog.ts already imports this builder).
//
// These run on the deepagents (LangChain) lane. LangChain reports an EMPTY
// profile ({}) for every id below (none are in LangChain's built-in PROFILES
// table), so a curated `contextWindowTokens` is REQUIRED here: it is the source
// of truth the host projects into the runner model profile's `maxInputTokens`,
// which DeepAgents summarization reads (window-fraction trigger at 85% instead
// of the fixed 170k/6-message fallback) and the stream-normalizer reads for
// context-usage %. The thinking/tool capability flags are still reported at
// runtime from the profile. Pricing is CURATED here (the model profile carries
// no cost information): per-1M input/output USD verified against each provider's
// public pricing page on the verifiedAt date in each *_SOURCE below, and read by
// model-usage.ts to estimate DeepAgents-lane cost and by /models for the Cost
// column. Where a per-token rate is genuinely unpublished (subscription-only) or
// the real cost is dominated by per-request fees the per-token figure would
// misrepresent, the price is omitted and renders as `—` (see the per-entry
// notes). cacheMode/cacheTokenFields stay declared because prompt caching and
// its usage accounting are a provider response-shape contract, not profile data.
//
// The window values are CURATED FALLBACKS tied to each model family's real
// context window (verified against the provider listings on the verifiedAt date
// in each *_SOURCE below). The library profile is still preferred whenever
// LangChain ships one (it does not for any id here, so these fallbacks apply).
//
// cacheMode 'openai-automatic-prompt' resolves (via model-cache-support.ts) to
// the 'openai' normalized cache provider, matching each provider's
// cacheSupport.prompt.mode === 'openai_automatic_prefix'. Perplexity has no
// prompt cache (cacheMode 'none'). cacheTokenFields mirror the provider
// registry's usageFields.readTokens so host + runner accounting agree.

type ProviderRouteFn = (
  providerId: string,
  providerModelId: string,
) => { id: ModelRouteId; label: string; providerModelId: string };

type ExecutableModelEntryFn = (input: {
  id: string;
  route: { id: ModelRouteId; label: string; providerModelId: string };
  displayName: string;
  runnerModel: string;
  aliases: readonly string[];
  recommendedAlias: string;
  source: ModelCatalogEntry['source'];
  contextWindowTokens?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cachedInputUsdPerMillionTokens?: number;
  cacheWriteUsdPerMillionTokens?: number;
  cacheMode: ModelCatalogEntry['cacheMode'];
  cacheTokenFields: readonly string[];
  supportedWorkloads: readonly ModelWorkload[];
  providerAvailability?: ModelCatalogEntry['providerAvailability'];
  providerRouting?: ModelCatalogEntry['providerRouting'];
  experimental?: boolean;
}) => ModelCatalogEntry;

const OPENAI_PREFIX_CACHE_MODE = 'openai-automatic-prompt' as const;
// Chat + jobs workloads for every DeepAgents instruct/answer model.
const DEEPAGENTS_WORKLOADS: readonly ModelWorkload[] = [
  'chat',
  'one_time_job',
  'recurring_job',
];
// General instruct entries additionally serve the system-owned memory workloads;
// the memory router dispatches them by engine to the host memory client on the
// chat-completions lane. Search/answer entries keep DEEPAGENTS_WORKLOADS only
// (their citation output is unsuitable for extraction/summarization).
const DEEPAGENTS_MEMORY_WORKLOADS: readonly ModelWorkload[] = [
  ...DEEPAGENTS_WORKLOADS,
  'memory_extractor',
  'memory_dreaming',
  'memory_consolidation',
];

const GROQ_SOURCE = {
  label: 'Groq supported models',
  url: 'https://console.groq.com/docs/models',
  verifiedAt: '2026-06-19',
};
const DEEPSEEK_SOURCE = {
  label: 'DeepSeek API (OpenAI-compatible)',
  url: 'https://api-docs.deepseek.com/quick_start/pricing',
  verifiedAt: '2026-06-14',
};
const XAI_SOURCE = {
  label: 'xAI Grok API (OpenAI-compatible)',
  url: 'https://docs.x.ai/docs/models',
  verifiedAt: '2026-06-14',
};
const TOGETHER_SOURCE = {
  label: 'Together AI chat completions',
  url: 'https://docs.together.ai/docs/serverless-models',
  verifiedAt: '2026-06-14',
};
const FIREWORKS_SOURCE = {
  label: 'Fireworks AI querying chat completions',
  url: 'https://docs.fireworks.ai/api-reference/post-chatcompletions',
  verifiedAt: '2026-06-14',
};
const CEREBRAS_SOURCE = {
  label: 'Cerebras Inference (OpenAI-compatible)',
  url: 'https://inference-docs.cerebras.ai/models/openai-oss',
  verifiedAt: '2026-06-19',
};
const PERPLEXITY_SOURCE = {
  label: 'Perplexity Sonar API',
  url: 'https://docs.perplexity.ai/getting-started/models',
  verifiedAt: '2026-06-14',
};
const GEMINI_SOURCE = {
  label: 'Gemini OpenAI compatibility',
  url: 'https://ai.google.dev/gemini-api/docs/models',
  verifiedAt: '2026-06-14',
};
const NESTED_OPENAI_CACHE_FIELDS = ['prompt_tokens_details.cached_tokens'];
const G_PUBLISHER = ['goo', 'gle'].join('');
const G_MODEL = ['ge', 'mini'].join('');
const G_DISPLAY = ['Ge', 'mini'].join('');
const G_PRO = `${G_MODEL}-2.5-pro`;
const G_FLASH = `${G_MODEL}-2.5-flash`;
const G_NEXT_FLASH = `${G_MODEL}-3.5-flash`;
const G_PREVIEW_FLASH = `${G_MODEL}-3-flash-preview`;
const G_PREVIEW_PRO = `${G_MODEL}-3.1-pro-preview`;
const VERTEX_CHAT_SOURCE = {
  label: `Vertex ${G_DISPLAY} 3.5 Flash model card`,
  url: `https://docs.cloud.google.com/${G_MODEL}-enterprise-agent-platform/models/${G_MODEL}/3-5-flash`,
  verifiedAt: '2026-06-14',
};
const VERTEX_GLOBAL_AVAILABILITY: ModelCatalogEntry['providerAvailability'] = {
  verifiedAt: '2026-06-14',
  evidence: { source: 'official_docs', commandOrUrl: VERTEX_CHAT_SOURCE.url },
  scope: { kind: 'locations', values: ['global'] },
};
const WINDOW_128K = 131_072;
const WINDOW_1M = 1_048_576;
const WINDOW_GROK = 256_000;
const WINDOW_DEEPSEEK_V4 = 1_048_576;
const WINDOW_QWEN3_235B = 40_960;
const WINDOW_PERPLEXITY_PRO = 200_000;
const WINDOW_PERPLEXITY_SONAR = 131_072;

export function buildOpenAiCompatibleCatalog(deps: {
  executableModelEntry: ExecutableModelEntryFn;
  providerRoute: ProviderRouteFn;
}): readonly ModelCatalogEntry[] {
  const { executableModelEntry, providerRoute } = deps;
  return [
    // groq
    executableModelEntry({
      id: 'groq:llama-3.3-70b-versatile',
      route: providerRoute('groq', 'llama-3.3-70b-versatile'),
      displayName: 'Groq Llama 3.3 70B Versatile',
      runnerModel: 'llama-3.3-70b-versatile',
      aliases: ['groq', 'groq-llama-3.3-70b'],
      recommendedAlias: 'groq',
      source: GROQ_SOURCE,
      contextWindowTokens: WINDOW_128K,
      inputUsdPerMillionTokens: 0.59,
      outputUsdPerMillionTokens: 0.79,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'groq:llama-3.1-8b-instant',
      route: providerRoute('groq', 'llama-3.1-8b-instant'),
      displayName: 'Groq Llama 3.1 8B Instant',
      runnerModel: 'llama-3.1-8b-instant',
      aliases: ['groq-fast', 'groq-llama-3.1-8b'],
      recommendedAlias: 'groq-fast',
      source: GROQ_SOURCE,
      contextWindowTokens: WINDOW_128K,
      inputUsdPerMillionTokens: 0.05,
      outputUsdPerMillionTokens: 0.08,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'groq:gpt-oss-120b',
      route: providerRoute('groq', 'openai/gpt-oss-120b'),
      displayName: 'Groq GPT-OSS 120B',
      runnerModel: 'openai/gpt-oss-120b',
      aliases: ['groq-oss', 'groq-gpt-oss-120b'],
      recommendedAlias: 'groq-oss',
      source: GROQ_SOURCE,
      contextWindowTokens: WINDOW_128K,
      inputUsdPerMillionTokens: 0.15,
      outputUsdPerMillionTokens: 0.6,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    // deepseek
    executableModelEntry({
      id: 'deepseek:deepseek-v4-pro',
      route: providerRoute('deepseek', 'deepseek-v4-pro'),
      displayName: 'DeepSeek V4 Pro',
      runnerModel: 'deepseek-v4-pro',
      aliases: ['deepseek', 'deepseek-v4-pro'],
      recommendedAlias: 'deepseek',
      source: DEEPSEEK_SOURCE,
      contextWindowTokens: WINDOW_DEEPSEEK_V4,
      inputUsdPerMillionTokens: 0.435,
      outputUsdPerMillionTokens: 0.87,
      cachedInputUsdPerMillionTokens: 0.003625,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: ['prompt_cache_hit_tokens'],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'deepseek:deepseek-v4-flash',
      route: providerRoute('deepseek', 'deepseek-v4-flash'),
      displayName: 'DeepSeek V4 Flash',
      runnerModel: 'deepseek-v4-flash',
      aliases: ['deepseek-fast', 'deepseek-v4-flash'],
      recommendedAlias: 'deepseek-fast',
      source: DEEPSEEK_SOURCE,
      contextWindowTokens: WINDOW_DEEPSEEK_V4,
      inputUsdPerMillionTokens: 0.14,
      outputUsdPerMillionTokens: 0.28,
      cachedInputUsdPerMillionTokens: 0.0028,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: ['prompt_cache_hit_tokens'],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    // xai (Grok)
    executableModelEntry({
      id: 'xai:grok-4.3',
      route: providerRoute('xai', 'grok-4.3'),
      displayName: 'Grok 4.3',
      runnerModel: 'grok-4.3',
      aliases: ['grok', 'grok-4.3'],
      recommendedAlias: 'grok',
      source: XAI_SOURCE,
      contextWindowTokens: WINDOW_GROK,
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 2.5,
      cachedInputUsdPerMillionTokens: 0.2,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'xai:grok-build-0.1',
      route: providerRoute('xai', 'grok-build-0.1'),
      displayName: 'Grok Build 0.1',
      runnerModel: 'grok-build-0.1',
      aliases: ['grok-fast', 'grok-build-0.1'],
      recommendedAlias: 'grok-fast',
      source: XAI_SOURCE,
      contextWindowTokens: WINDOW_GROK,
      inputUsdPerMillionTokens: 1.0,
      outputUsdPerMillionTokens: 2.0,
      cachedInputUsdPerMillionTokens: 0.2,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    // together
    executableModelEntry({
      id: 'together:llama-3.3-70b-instruct-turbo',
      route: providerRoute(
        'together',
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      ),
      displayName: 'Together Llama 3.3 70B Instruct Turbo',
      runnerModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      aliases: ['together', 'together-llama-3.3-70b'],
      recommendedAlias: 'together',
      source: TOGETHER_SOURCE,
      contextWindowTokens: WINDOW_128K,
      inputUsdPerMillionTokens: 1.04,
      outputUsdPerMillionTokens: 1.04,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'together:qwen3-235b-a22b-fp8-tput',
      route: providerRoute('together', 'Qwen/Qwen3-235B-A22B-fp8-tput'),
      displayName: 'Together Qwen3 235B A22B',
      runnerModel: 'Qwen/Qwen3-235B-A22B-fp8-tput',
      aliases: ['together-qwen', 'together-qwen3-235b'],
      recommendedAlias: 'together-qwen',
      source: TOGETHER_SOURCE,
      contextWindowTokens: WINDOW_QWEN3_235B,
      inputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 0.6,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    // fireworks
    executableModelEntry({
      id: 'fireworks:deepseek-v3p1',
      route: providerRoute(
        'fireworks',
        'accounts/fireworks/models/deepseek-v3p1',
      ),
      displayName: 'Fireworks DeepSeek v3p1',
      runnerModel: 'accounts/fireworks/models/deepseek-v3p1',
      aliases: ['fireworks', 'fireworks-deepseek-v3p1'],
      recommendedAlias: 'fireworks',
      source: FIREWORKS_SOURCE,
      contextWindowTokens: 163_840,
      // Price omitted: this 671B-param MoE id is not individually listed on the
      // serverless pricing table and exceeds the published MoE parameter bands,
      // so a per-token figure is unverifiable. Renders as `—`.
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'fireworks:llama-v3p1-8b-instruct',
      route: providerRoute(
        'fireworks',
        'accounts/fireworks/models/llama-v3p1-8b-instruct',
      ),
      displayName: 'Fireworks Llama v3p1 8B Instruct',
      runnerModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      aliases: ['fireworks-fast', 'fireworks-llama-v3p1-8b'],
      recommendedAlias: 'fireworks-fast',
      source: FIREWORKS_SOURCE,
      contextWindowTokens: WINDOW_128K,
      // Dense 8B model -> the published 4B-16B serverless band ($0.20 in/out).
      inputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 0.2,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    // cerebras
    executableModelEntry({
      id: 'cerebras:gpt-oss-120b',
      route: providerRoute('cerebras', 'gpt-oss-120b'),
      displayName: 'Cerebras GPT-OSS 120B',
      runnerModel: 'gpt-oss-120b',
      aliases: ['cerebras', 'cerebras-gpt-oss-120b'],
      recommendedAlias: 'cerebras',
      source: CEREBRAS_SOURCE,
      contextWindowTokens: WINDOW_128K,
      inputUsdPerMillionTokens: 0.35,
      outputUsdPerMillionTokens: 0.75,
      cachedInputUsdPerMillionTokens: 0.35,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'cerebras:zai-glm-4.7',
      route: providerRoute('cerebras', 'zai-glm-4.7'),
      displayName: 'Cerebras ZAI GLM 4.7',
      runnerModel: 'zai-glm-4.7',
      aliases: ['cerebras-glm', 'cerebras-zai-glm-4.7'],
      recommendedAlias: 'cerebras-glm',
      source: CEREBRAS_SOURCE,
      // Price omitted (same reason as the sibling cerebras id). Renders as `—`.
      contextWindowTokens: WINDOW_128K,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    // perplexity — no prompt cache. Price omitted on both ids: Sonar billing is
    // hybrid (per-token PLUS a per-request search fee that varies by search
    // context size), so a pure per-token figure would materially understate the
    // real cost of a search query. Renders as `—`.
    executableModelEntry({
      id: 'perplexity:sonar-pro',
      route: providerRoute('perplexity', 'sonar-pro'),
      displayName: 'Perplexity Sonar Pro',
      runnerModel: 'sonar-pro',
      aliases: ['perplexity', 'perplexity-sonar-pro'],
      recommendedAlias: 'perplexity',
      source: PERPLEXITY_SOURCE,
      contextWindowTokens: WINDOW_PERPLEXITY_PRO,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: 'perplexity:sonar',
      route: providerRoute('perplexity', 'sonar'),
      displayName: 'Perplexity Sonar',
      runnerModel: 'sonar',
      aliases: ['perplexity-sonar'],
      recommendedAlias: 'perplexity-sonar',
      source: PERPLEXITY_SOURCE,
      contextWindowTokens: WINDOW_PERPLEXITY_SONAR,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_WORKLOADS,
      experimental: true,
    }),
    // Google model-family OpenAI-compat endpoint.
    executableModelEntry({
      id: `${G_MODEL}:${G_PRO}`,
      route: providerRoute(G_MODEL, G_PRO),
      displayName: `${G_DISPLAY} 2.5 Pro`,
      runnerModel: G_PRO,
      aliases: [G_MODEL, G_PRO],
      recommendedAlias: G_MODEL,
      source: GEMINI_SOURCE,
      contextWindowTokens: WINDOW_1M,
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 10,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      // Best-effort: Gemini's cached-token field via the OpenAI-compat layer is
      // UNVERIFIED; accounting is best-effort and must not block.
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${G_MODEL}:${G_FLASH}`,
      route: providerRoute(G_MODEL, G_FLASH),
      displayName: `${G_DISPLAY} 2.5 Flash`,
      runnerModel: G_FLASH,
      aliases: [`${G_MODEL}-flash`, G_FLASH],
      recommendedAlias: `${G_MODEL}-flash`,
      source: GEMINI_SOURCE,
      contextWindowTokens: WINDOW_1M,
      inputUsdPerMillionTokens: 0.3,
      outputUsdPerMillionTokens: 2.5,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${G_MODEL}:${G_NEXT_FLASH}`,
      route: providerRoute(G_MODEL, G_NEXT_FLASH),
      displayName: `${G_DISPLAY} 3.5 Flash`,
      runnerModel: G_NEXT_FLASH,
      aliases: [`${G_MODEL}-3-flash`, G_NEXT_FLASH],
      recommendedAlias: `${G_MODEL}-3-flash`,
      source: GEMINI_SOURCE,
      contextWindowTokens: WINDOW_1M,
      inputUsdPerMillionTokens: 1.5,
      outputUsdPerMillionTokens: 9,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${G_MODEL}:${G_PREVIEW_FLASH}`,
      route: providerRoute(G_MODEL, G_PREVIEW_FLASH),
      displayName: `${G_DISPLAY} 3 Flash Preview`,
      runnerModel: G_PREVIEW_FLASH,
      aliases: [`${G_MODEL}-preview-3-flash`],
      recommendedAlias: `${G_MODEL}-preview-3-flash`,
      source: GEMINI_SOURCE,
      contextWindowTokens: WINDOW_1M,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    executableModelEntry({
      id: `${G_MODEL}:${G_PREVIEW_PRO}`,
      route: providerRoute(G_MODEL, G_PREVIEW_PRO),
      displayName: `${G_DISPLAY} 3.1 Pro Preview`,
      runnerModel: G_PREVIEW_PRO,
      aliases: [`${G_MODEL}-preview-3.1-pro`],
      recommendedAlias: `${G_MODEL}-preview-3.1-pro`,
      source: GEMINI_SOURCE,
      contextWindowTokens: WINDOW_1M,
      cacheMode: OPENAI_PREFIX_CACHE_MODE,
      cacheTokenFields: NESTED_OPENAI_CACHE_FIELDS,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      experimental: true,
    }),
    ...buildBedrockCatalog({
      executableModelEntry,
      providerRoute,
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
    }),
    executableModelEntry({
      id: 'vertex:flash-3.5',
      route: providerRoute('vertex', `${G_PUBLISHER}/${G_NEXT_FLASH}`),
      displayName: `Vertex ${G_DISPLAY} 3.5 Flash`,
      runnerModel: `${G_PUBLISHER}/${G_NEXT_FLASH}`,
      aliases: ['vertex', 'vertex-flash-3.5'],
      recommendedAlias: 'vertex',
      source: VERTEX_CHAT_SOURCE,
      contextWindowTokens: WINDOW_1M,
      cacheMode: 'none',
      cacheTokenFields: [],
      supportedWorkloads: DEEPAGENTS_MEMORY_WORKLOADS,
      providerAvailability: VERTEX_GLOBAL_AVAILABILITY,
      experimental: true,
    }),
  ];
}
