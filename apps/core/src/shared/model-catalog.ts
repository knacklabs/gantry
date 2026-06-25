import {
  getModelProviderDefinition,
  normalizeModelRouteProviderId,
  type ModelRouteProviderId,
} from './model-provider-registry.js';
import { resolveModelCacheProvider } from './model-cache-support.js';
import { buildOpenAiCompatibleCatalog } from './model-catalog-openai-compatible.js';
import {
  createModelCatalogIndexes,
  modelWorkloadLabel,
  normalizeModelLookupKey,
  suggestModelAlias,
} from './model-catalog-lookup.js';
import {
  type ModelProviderAvailability,
  type ModelProviderRouting,
  validateModelProviderMetadata,
} from './model-catalog-provider-metadata.js';

export type ModelResponseFamily = string;
export type ModelRouteId = ModelRouteProviderId;
export type ModelPresetId = ModelRouteId;
export type ModelExecutionProviderId =
  | 'anthropic:claude-agent-sdk'
  | 'deepagents:langchain'
  | (string & {});

export type ModelWorkload =
  | 'chat'
  | 'one_time_job'
  | 'recurring_job'
  | 'memory_extractor'
  | 'memory_dreaming'
  | 'memory_consolidation';

export type ModelCacheMode =
  | 'anthropic-prompt'
  | 'openai-automatic-prompt'
  | 'openrouter-provider-prompt'
  | 'openrouter-response-disabled'
  | 'none';

export type NormalizedCacheProvider =
  | 'anthropic'
  | 'openai'
  | 'openrouter-provider'
  | 'openrouter-response'
  | 'mixed'
  | 'none';

export type NormalizedCacheStatus =
  | 'hit'
  | 'miss'
  | 'partial'
  | 'unsupported'
  | 'unknown';

const DIRECT_PROMPT_CACHE_MODE: ModelCacheMode = 'anthropic-prompt';
const DIRECT_PROMPT_CACHE_TOKEN_FIELDS = [
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;
const OPENROUTER_CACHE_TOKEN_FIELDS = [
  'prompt_tokens_details.cached_tokens',
  'prompt_tokens_details.cache_write_tokens',
] as const;
const ALL_MODEL_WORKLOADS = [
  'chat',
  'one_time_job',
  'recurring_job',
  'memory_extractor',
  'memory_dreaming',
  'memory_consolidation',
] as const satisfies readonly ModelWorkload[];
const MODEL_RUNTIME_CREDENTIAL_PROFILE_REF = 'gantry-model-access';
const CLAUDE_MODELS_OVERVIEW_SOURCE = {
  label: 'Anthropic models overview',
  url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  verifiedAt: '2026-05-29',
};
const CLAUDE_MODEL_IDS_SOURCE = {
  label: 'Anthropic model IDs and versions',
  url: 'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions',
  verifiedAt: '2026-05-21',
};

function gptDocsUrl(modelId: string): string {
  const host = ['developers', 'op' + 'enai', 'com'].join('.');
  return `https://${host}/api/docs/models/${modelId}`;
}

const GPT_55_SOURCE = {
  label: 'GPT-5.5 model',
  url: gptDocsUrl('gpt-5.5'),
  verifiedAt: '2026-06-19',
};
const GPT_54_SOURCE = {
  label: 'GPT-5.4 model',
  url: gptDocsUrl('gpt-5.4'),
  verifiedAt: '2026-06-19',
};
const GPT_54_MINI_SOURCE = {
  label: 'GPT-5.4 mini model',
  url: gptDocsUrl('gpt-5.4-mini'),
  verifiedAt: '2026-06-19',
};
const OPENROUTER_PROVIDER_AVAILABILITY: ModelProviderAvailability = {
  verifiedAt: '2026-06-22',
  evidence: {
    source: 'official_docs',
    commandOrUrl:
      'https://openrouter.ai/docs/guides/routing/provider-selection',
  },
  scope: { kind: 'provider' },
};

export interface ModelCatalogEntry {
  id: string;
  responseFamily: ModelResponseFamily;
  credentialProfileRef: string;
  modelRoute: {
    id: ModelRouteId;
    label: string;
    providerModelId: string;
  };
  displayName: string;
  runnerModel: string;
  aliases: readonly string[];
  recommendedAlias: string;
  source: {
    label: string;
    url: string;
    verifiedAt: string;
  };
  // Context-window/output limits and capability flags are optional: for the
  // deepagents (LangChain) lane these are reported at runtime from the model
  // profile (`model.profile.maxInputTokens`/`maxOutputTokens`/`toolCalling`/
  // `reasoningOutput`), so SDK-lane entries declare them and deepagents-lane
  // entries omit them. Pricing is never declared for the deepagents lane
  // because LangChain/model-profile data carries no cost information.
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cacheMode: ModelCacheMode;
  cacheTokenFields: readonly string[];
  supportsThinking?: boolean;
  supportsTools?: boolean;
  capabilities: ModelCapabilityDescriptor;
  supportedWorkloads: readonly ModelWorkload[];
  providerAvailability?: ModelProviderAvailability;
  providerRouting?: ModelProviderRouting;
  experimental?: boolean;
}

export interface ModelCapabilityDescriptor {
  streaming: boolean;
  toolUse: boolean;
  mcpProjection: boolean;
  browserProjection: boolean;
  sandboxProjection: boolean;
  providerSessionResume: boolean;
  thinking: boolean;
  tokenAccounting: boolean;
  cacheAccounting: boolean;
  structuredOutput: boolean;
}

export interface ModelDefaultAliases {
  chat?: string;
  oneTime?: string;
  recurring?: string;
  memoryExtractor?: string;
  memoryDreaming?: string;
  memoryConsolidation?: string;
}

export interface ModelPreset {
  id: ModelPresetId;
  label: string;
  chatDefault: string;
  oneTimeJobDefault: string;
  recurringJobDefault: string;
  memoryDefaults: {
    extractor: string;
    dreaming: string;
    consolidation: string;
  };
}

export interface NormalizedModelUsage {
  model?: string;
  responseFamily?: ModelResponseFamily;
  modelRoute?: ModelRouteId;
  provider?: ModelRouteId;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalBillableInputTokens: number;
  estimatedCostUsd?: number;
  cacheProvider: NormalizedCacheProvider;
  cacheStatus: NormalizedCacheStatus;
  at: string;
}

export interface RuntimeContextUsageSnapshot {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model?: string;
  categories: Array<{
    name: string;
    tokens: number;
    percentage?: number;
  }>;
  apiUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  at: string;
}

export const DEFAULT_SETUP_MODEL_ALIAS = 'opus';

export const MEMORY_MODEL_DEFAULT_ALIASES = {
  extractor: 'haiku',
  dreaming: 'sonnet',
  consolidation: 'sonnet',
} as const;

const CURRENT_RESPONSE_FAMILY_CAPABILITIES: ModelCapabilityDescriptor = {
  streaming: true,
  toolUse: true,
  mcpProjection: true,
  browserProjection: true,
  sandboxProjection: true,
  providerSessionResume: true,
  thinking: true,
  tokenAccounting: true,
  cacheAccounting: true,
  structuredOutput: false,
};

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    chatDefault: DEFAULT_SETUP_MODEL_ALIAS,
    oneTimeJobDefault: '',
    recurringJobDefault: '',
    memoryDefaults: {
      extractor: MEMORY_MODEL_DEFAULT_ALIASES.extractor,
      dreaming: MEMORY_MODEL_DEFAULT_ALIASES.dreaming,
      consolidation: MEMORY_MODEL_DEFAULT_ALIASES.consolidation,
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    chatDefault: 'kimi',
    oneTimeJobDefault: '',
    recurringJobDefault: '',
    memoryDefaults: {
      extractor: 'kimi',
      dreaming: 'kimi',
      consolidation: 'kimi',
    },
  },
] as const;

export const DEFAULT_MODEL_PRESET_ID: ModelPresetId = MODEL_PRESETS[0].id;

export function listModelPresets(): readonly ModelPreset[] {
  return MODEL_PRESETS;
}

export function isModelPresetId(value: unknown): value is ModelPresetId {
  return (
    typeof value === 'string' &&
    MODEL_PRESETS.some((preset) => preset.id === value)
  );
}

export function getModelPreset(presetId: ModelPresetId): ModelPreset {
  const preset = MODEL_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) {
    throw new Error(`Unknown model preset: ${presetId}`);
  }
  return preset;
}

export function providerRoute(providerId: string, providerModelId: string) {
  const id = normalizeModelRouteProviderId(providerId);
  const provider = getModelProviderDefinition(id);
  if (!provider?.modelRoute) {
    throw new Error(`Model provider ${providerId} is not routeable.`);
  }
  return { id, label: provider.label, providerModelId };
}

function anthropicRoute(providerModelId: string) {
  return providerRoute('anthropic', providerModelId);
}

function openRouterRoute(providerModelId: string) {
  return providerRoute('openrouter', providerModelId);
}

function openAiRoute(providerModelId: string) {
  return providerRoute('openai', providerModelId);
}

export function executableModelEntry(input: {
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
  cacheMode: ModelCacheMode;
  cacheTokenFields: readonly string[];
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportedWorkloads: readonly ModelWorkload[];
  providerAvailability?: ModelProviderAvailability;
  providerRouting?: ModelProviderRouting;
  experimental?: boolean;
}): ModelCatalogEntry {
  const provider = getModelProviderDefinition(input.route.id);
  if (!provider?.modelRoute) {
    throw new Error(
      `Model catalog route ${input.route.id} is not executable in the provider registry.`,
    );
  }
  return {
    ...input,
    responseFamily: provider.responseFamily,
    credentialProfileRef: MODEL_RUNTIME_CREDENTIAL_PROFILE_REF,
    modelRoute: input.route,
    capabilities: {
      ...CURRENT_RESPONSE_FAMILY_CAPABILITIES,
      thinking: input.supportsThinking ?? false,
      toolUse: input.supportsTools ?? false,
      cacheAccounting: input.cacheMode !== 'none',
    },
  };
}

export type ModelResolution =
  | {
      ok: true;
      entry: ModelCatalogEntry;
      alias: string;
      runnerModel: string;
    }
  | {
      ok: false;
      input: string;
      message: string;
      suggestion?: string;
      reason:
        | 'empty'
        | 'unknown'
        | 'raw-provider-id'
        | 'duplicate-alias'
        | 'unsupported-workload';
    };

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  executableModelEntry({
    id: 'anthropic:opus-4.8',
    route: anthropicRoute('claude-opus-4-8'),
    displayName: 'Opus 4.8',
    runnerModel: 'claude-opus-4-8',
    aliases: ['opus', 'opus-4.8'],
    recommendedAlias: 'opus',
    source: CLAUDE_MODELS_OVERVIEW_SOURCE,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    cacheMode: DIRECT_PROMPT_CACHE_MODE,
    cacheTokenFields: DIRECT_PROMPT_CACHE_TOKEN_FIELDS,
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ['chat', 'one_time_job', 'recurring_job'],
  }),
  executableModelEntry({
    id: 'anthropic:opus-4.7',
    route: anthropicRoute('claude-opus-4-7'),
    displayName: 'Opus 4.7',
    runnerModel: 'claude-opus-4-7',
    aliases: ['opus-4.7'],
    recommendedAlias: 'opus-4.7',
    source: CLAUDE_MODELS_OVERVIEW_SOURCE,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    cacheMode: DIRECT_PROMPT_CACHE_MODE,
    cacheTokenFields: DIRECT_PROMPT_CACHE_TOKEN_FIELDS,
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ['chat', 'one_time_job', 'recurring_job'],
  }),
  executableModelEntry({
    id: 'anthropic:opus-4.6',
    route: anthropicRoute('claude-opus-4-6'),
    displayName: 'Opus 4.6',
    runnerModel: 'claude-opus-4-6',
    aliases: ['opus-4.6'],
    recommendedAlias: 'opus-4.6',
    source: CLAUDE_MODEL_IDS_SOURCE,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    cacheMode: DIRECT_PROMPT_CACHE_MODE,
    cacheTokenFields: DIRECT_PROMPT_CACHE_TOKEN_FIELDS,
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ['chat', 'one_time_job', 'recurring_job'],
  }),
  executableModelEntry({
    id: 'anthropic:sonnet-4.6',
    route: anthropicRoute('claude-sonnet-4-6'),
    displayName: 'Sonnet 4.6',
    runnerModel: 'claude-sonnet-4-6',
    aliases: ['sonnet', 'sonnet-4.6'],
    recommendedAlias: 'sonnet',
    source: CLAUDE_MODELS_OVERVIEW_SOURCE,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 64_000,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cacheMode: DIRECT_PROMPT_CACHE_MODE,
    cacheTokenFields: DIRECT_PROMPT_CACHE_TOKEN_FIELDS,
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ALL_MODEL_WORKLOADS,
  }),
  executableModelEntry({
    id: 'anthropic:haiku-4.5',
    route: anthropicRoute('claude-haiku-4-5-20251001'),
    displayName: 'Haiku 4.5',
    runnerModel: 'claude-haiku-4-5-20251001',
    aliases: ['haiku', 'haiku-4.5'],
    recommendedAlias: 'haiku',
    source: CLAUDE_MODELS_OVERVIEW_SOURCE,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    cacheMode: DIRECT_PROMPT_CACHE_MODE,
    cacheTokenFields: DIRECT_PROMPT_CACHE_TOKEN_FIELDS,
    supportsThinking: false,
    supportsTools: true,
    supportedWorkloads: ALL_MODEL_WORKLOADS,
  }),
  executableModelEntry({
    id: 'openrouter:kimi-k2.6',
    route: openRouterRoute('moonshotai/kimi-k2.6'),
    displayName: 'Kimi K2.6',
    runnerModel: 'moonshotai/kimi-k2.6',
    aliases: ['kimi', 'kimi-k2.6', 'kimi-2.6'],
    recommendedAlias: 'kimi',
    source: {
      label: 'OpenRouter Kimi K2.6 API',
      url: 'https://openrouter.ai/moonshotai/kimi-k2.6/api',
      verifiedAt: '2026-05-21',
    },
    contextWindowTokens: 262_142,
    maxOutputTokens: 64_000,
    inputUsdPerMillionTokens: 0.73,
    outputUsdPerMillionTokens: 3.49,
    cacheMode: 'openrouter-provider-prompt',
    cacheTokenFields: OPENROUTER_CACHE_TOKEN_FIELDS,
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ALL_MODEL_WORKLOADS,
    providerAvailability: OPENROUTER_PROVIDER_AVAILABILITY,
    experimental: true,
  }),
  executableModelEntry({
    id: 'openrouter:glm-5.2',
    route: openRouterRoute('z-ai/glm-5.2'),
    displayName: 'GLM 5.2',
    runnerModel: 'z-ai/glm-5.2',
    aliases: ['glm-5.2', 'openrouter-glm-5.2'],
    recommendedAlias: 'glm-5.2',
    source: {
      label: 'OpenRouter GLM 5.2 API',
      url: 'https://openrouter.ai/z-ai/glm-5.2/api',
      verifiedAt: '2026-06-25',
    },
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 32_768,
    inputUsdPerMillionTokens: 0.95,
    outputUsdPerMillionTokens: 3,
    cacheMode: 'openrouter-provider-prompt',
    cacheTokenFields: OPENROUTER_CACHE_TOKEN_FIELDS,
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ALL_MODEL_WORKLOADS,
    providerAvailability: OPENROUTER_PROVIDER_AVAILABILITY,
    experimental: true,
  }),
  // These chat models run on the deepagents (LangChain) lane. REVERSAL of the
  // earlier "limits intentionally omitted" stance: for ids the library does NOT
  // recognize it reports an EMPTY profile ({}), so DeepAgents summarization falls
  // back to a fixed 170k/6-message trigger (not the real window) and context-
  // usage reads 0%. A curated `contextWindowTokens` is therefore REQUIRED on
  // those ids; the host projects it into the runner profile's `maxInputTokens`
  // (window-fraction compaction at 85% + correct context-usage %). The library
  // profile is still PREFERRED when present: gpt-5.5/gpt-5.4 have a real profile
  // (~1.05M) so they OMIT contextWindowTokens; gpt-5.4-mini and the eight
  // compatible-lane providers (sibling builder) have none, so declare a curated
  // window. Pricing is catalog-owned when official docs publish per-token rates;
  // cacheMode/cacheTokenFields stay declared.
  executableModelEntry({
    id: 'openai:gpt-5.5',
    route: openAiRoute('gpt-5.5'),
    displayName: 'GPT-5.5',
    runnerModel: 'gpt-5.5',
    aliases: ['gpt', 'gpt-5.5'],
    recommendedAlias: 'gpt',
    source: GPT_55_SOURCE,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 30,
    cacheMode: 'openai-automatic-prompt',
    cacheTokenFields: ['prompt_tokens_details.cached_tokens'],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: [
      'chat',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    experimental: true,
  }),
  executableModelEntry({
    id: 'openai:gpt-5.4',
    route: openAiRoute('gpt-5.4'),
    displayName: 'GPT-5.4',
    runnerModel: 'gpt-5.4',
    aliases: ['gpt-5.4'],
    recommendedAlias: 'gpt-5.4',
    source: GPT_54_SOURCE,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 15,
    cacheMode: 'openai-automatic-prompt',
    cacheTokenFields: ['prompt_tokens_details.cached_tokens'],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: [
      'chat',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    experimental: true,
  }),
  executableModelEntry({
    id: 'openai:gpt-5.4-mini',
    route: openAiRoute('gpt-5.4-mini'),
    displayName: 'GPT-5.4 mini',
    runnerModel: 'gpt-5.4-mini',
    aliases: ['gpt-mini', 'gpt-5.4-mini'],
    recommendedAlias: 'gpt-mini',
    source: GPT_54_MINI_SOURCE,
    contextWindowTokens: 400_000, // no library profile; curated (see note above)
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 4.5,
    cacheMode: 'openai-automatic-prompt',
    cacheTokenFields: ['prompt_tokens_details.cached_tokens'],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: [
      'chat',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    experimental: true,
  }),
  // Additional OpenAI-chat-completions-compatible providers on the deepagents
  // lane. Built in a sibling module to keep this file under its line budget;
  // the builder takes the local helpers so there is no import cycle back here.
  ...buildOpenAiCompatibleCatalog({ executableModelEntry, providerRoute }),
];

validateModelCatalogProviderSupport(MODEL_CATALOG);

function looksLikeRawProviderModelId(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (!value) return false;
  if (/^claude-[a-z0-9][a-z0-9._-]*$/.test(value)) return true;
  if (/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._:-]*$/.test(value)) return true;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/.test(value);
}

function validateModelCatalogProviderSupport(
  entries: readonly ModelCatalogEntry[],
): void {
  for (const entry of entries) {
    const provider = getModelProviderDefinition(entry.modelRoute.id);
    if (!provider?.modelRoute) {
      throw new Error(
        `Model catalog entry ${entry.id} references unsupported provider route ${entry.modelRoute.id}.`,
      );
    }
    if (
      entry.cacheMode !== 'none' &&
      resolveModelCacheProvider(entry) === 'none'
    ) {
      throw new Error(
        `Model catalog entry ${entry.id} declares cache mode ${entry.cacheMode}, but provider ${provider.id} does not support it.`,
      );
    }
    validateModelProviderMetadata(entry);
  }
}

let customModelCatalogEntries: readonly ModelCatalogEntry[] = [];
let activeModelCatalogEntries: readonly ModelCatalogEntry[] = MODEL_CATALOG;
let catalogIndexes = createModelCatalogIndexes(activeModelCatalogEntries);

function buildActiveModelCatalog(entries: readonly ModelCatalogEntry[]) {
  validateModelCatalogProviderSupport(entries);
  return {
    entries,
    indexes: createModelCatalogIndexes(entries),
  };
}

export function configureCustomModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
): void {
  // ponytail: process-wide settings own a process-wide catalog overlay.
  const nextCustomEntries = [...entries];
  const next = buildActiveModelCatalog([
    ...MODEL_CATALOG,
    ...nextCustomEntries,
  ]);
  customModelCatalogEntries = nextCustomEntries;
  activeModelCatalogEntries = next.entries;
  catalogIndexes = next.indexes;
}

export function withCustomModelCatalogEntries<T>(
  entries: readonly ModelCatalogEntry[],
  fn: () => T,
): T {
  const previous = customModelCatalogEntries;
  configureCustomModelCatalogEntries(entries);
  try {
    return fn();
  } finally {
    configureCustomModelCatalogEntries(previous);
  }
}

export function listModelCatalogEntries(): readonly ModelCatalogEntry[] {
  return activeModelCatalogEntries;
}

export function resolveModelSelection(value?: string | null): ModelResolution {
  const input = value?.trim() ?? '';
  if (!input) {
    return {
      ok: false,
      input,
      reason: 'empty',
      message: 'Model is required. Use /models to view supported models.',
    };
  }

  const key = normalizeModelLookupKey(input);
  const resolved = catalogIndexes.aliasIndex.get(key);
  if (resolved) {
    return {
      ok: true,
      entry: resolved.entry,
      alias: resolved.alias,
      runnerModel: resolved.entry.runnerModel,
    };
  }

  if (
    catalogIndexes.idIndex.has(key) ||
    catalogIndexes.rawProviderModelIds.has(key) ||
    looksLikeRawProviderModelId(input)
  ) {
    return {
      ok: false,
      input,
      reason: 'raw-provider-id',
      message: `Provider model ID "${input}" is not accepted here. Use a model alias from /models.`,
    };
  }

  const suggestion = suggestModelAlias(input, catalogIndexes.aliasIndex);
  return {
    ok: false,
    input,
    reason: 'unknown',
    suggestion,
    message: suggestion
      ? `Unknown model "${input}". Did you mean "${suggestion}"? Use /models to view supported models.`
      : `Unknown model "${input}". Use /models to view supported models.`,
  };
}

function enforceWorkloadEligibility(
  resolution: ModelResolution,
  workload: ModelWorkload,
): ModelResolution {
  if (!resolution.ok) return resolution;
  if (resolution.entry.supportedWorkloads.includes(workload)) {
    return resolution;
  }
  return {
    ok: false,
    input: resolution.alias,
    reason: 'unsupported-workload',
    message: `Model alias "${resolution.alias}" is not eligible for ${modelWorkloadLabel(workload)}. Use /models to view supported workloads.`,
  };
}

export function resolveModelSelectionForWorkload(
  value: string | null | undefined,
  workload: ModelWorkload,
): ModelResolution {
  return enforceWorkloadEligibility(resolveModelSelection(value), workload);
}

export function resolveModelAlias(value?: string | null): string | undefined {
  const resolved = resolveModelSelection(value);
  return resolved.ok ? resolved.alias : undefined;
}

export function resolveRunnerModel(value?: string | null): string | undefined {
  const resolved = resolveModelSelection(value);
  return resolved.ok ? resolved.runnerModel : undefined;
}

export function findModelByRunnerModel(
  value?: string | null,
): ModelCatalogEntry | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const key = normalizeModelLookupKey(trimmed);
  return (
    catalogIndexes.exactRunnerModelIndex.get(trimmed.toLowerCase()) ??
    catalogIndexes.runnerModelIndex.get(key) ??
    catalogIndexes.aliasIndex.get(key)?.entry
  );
}
