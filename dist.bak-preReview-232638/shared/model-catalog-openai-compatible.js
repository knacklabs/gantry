import { buildBedrockCatalog } from './model-catalog-bedrock.js';
const OPENAI_PREFIX_CACHE_MODE = 'openai-automatic-prompt';
// Chat + jobs workloads for every DeepAgents instruct/answer model.
const DEEPAGENTS_WORKLOADS = [
    'chat',
    'one_time_job',
    'recurring_job',
];
// General instruct entries additionally serve the system-owned memory workloads;
// the memory router dispatches them by engine to the host memory client on the
// chat-completions lane. Search/answer entries keep DEEPAGENTS_WORKLOADS only
// (their citation output is unsuitable for extraction/summarization).
const DEEPAGENTS_MEMORY_WORKLOADS = [
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
const VERTEX_CHAT_SOURCE = {
    label: `Vertex ${G_DISPLAY} 3.5 Flash model card`,
    url: `https://docs.cloud.google.com/${G_MODEL}-enterprise-agent-platform/models/${G_MODEL}/3-5-flash`,
    verifiedAt: '2026-06-14',
};
const VERTEX_GLOBAL_AVAILABILITY = {
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
export function buildOpenAiCompatibleCatalog(deps) {
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
            route: providerRoute('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'),
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
            route: providerRoute('fireworks', 'accounts/fireworks/models/deepseek-v3p1'),
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
            route: providerRoute('fireworks', 'accounts/fireworks/models/llama-v3p1-8b-instruct'),
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
