export type ModelResponseFamily = 'anthropic' | 'openai';
export type ModelRouteId = 'anthropic' | 'openrouter';
export type ModelPresetId = ModelRouteId;
export type ModelExecutionProviderId = 'anthropic:claude-agent-sdk';

export type ModelWorkload =
  | 'chat'
  | 'one_time_job'
  | 'recurring_job'
  | 'memory_extractor'
  | 'memory_dreaming'
  | 'memory_consolidation';

export type ModelCacheMode =
  | 'anthropic-prompt'
  | 'openrouter-provider-prompt'
  | 'openrouter-response-disabled'
  | 'none';

export type NormalizedCacheProvider =
  | 'anthropic'
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
const MODEL_RUNTIME_CREDENTIAL_PROFILE_REF = 'gantry-model-access';
const CLAUDE_MODELS_OVERVIEW_SOURCE = {
  label: 'Anthropic models overview',
  url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  verifiedAt: '2026-05-21',
};
const CLAUDE_MODEL_IDS_SOURCE = {
  label: 'Anthropic model IDs and versions',
  url: 'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions',
  verifiedAt: '2026-05-21',
};

export interface ModelCatalogEntry {
  id: string;
  responseFamily: ModelResponseFamily;
  executionProviderId: ModelExecutionProviderId;
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
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cacheMode: ModelCacheMode;
  cacheTokenFields: readonly string[];
  supportsThinking: boolean;
  supportsTools: boolean;
  capabilities: ModelCapabilityDescriptor;
  supportedWorkloads: readonly ModelWorkload[];
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

function anthropicRoute(providerModelId: string) {
  return { id: 'anthropic' as const, label: 'Anthropic', providerModelId };
}

function openRouterRoute(providerModelId: string) {
  return { id: 'openrouter' as const, label: 'OpenRouter', providerModelId };
}

function anthropicEntry(input: {
  id: string;
  route: { id: ModelRouteId; label: string; providerModelId: string };
  displayName: string;
  runnerModel: string;
  aliases: readonly string[];
  recommendedAlias: string;
  source: ModelCatalogEntry['source'];
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cacheMode: ModelCacheMode;
  cacheTokenFields: readonly string[];
  supportsThinking: boolean;
  supportsTools: boolean;
  supportedWorkloads: readonly ModelWorkload[];
  experimental?: boolean;
}): ModelCatalogEntry {
  return {
    ...input,
    responseFamily: 'anthropic',
    executionProviderId: 'anthropic:claude-agent-sdk',
    credentialProfileRef: MODEL_RUNTIME_CREDENTIAL_PROFILE_REF,
    modelRoute: input.route,
    capabilities: {
      ...CURRENT_RESPONSE_FAMILY_CAPABILITIES,
      thinking: input.supportsThinking,
      toolUse: input.supportsTools,
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
  anthropicEntry({
    id: 'anthropic:opus-4.7',
    route: anthropicRoute('claude-opus-4-7'),
    displayName: 'Opus 4.7',
    runnerModel: 'claude-opus-4-7',
    aliases: ['opus', 'opus-4.7'],
    recommendedAlias: 'opus',
    source: CLAUDE_MODELS_OVERVIEW_SOURCE,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    cacheMode: DIRECT_PROMPT_CACHE_MODE,
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ['chat', 'one_time_job', 'recurring_job'],
  }),
  anthropicEntry({
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
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: ['chat', 'one_time_job', 'recurring_job'],
  }),
  anthropicEntry({
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
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: [
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
  }),
  anthropicEntry({
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
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: false,
    supportsTools: true,
    supportedWorkloads: [
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
  }),
  anthropicEntry({
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
    cacheTokenFields: [
      'prompt_tokens_details.cached_tokens',
      'prompt_tokens_details.cache_write_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
    supportedWorkloads: [
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    experimental: true,
  }),
] as const;

const RAW_PROVIDER_MODEL_IDS = new Set(
  MODEL_CATALOG.flatMap((entry) => [
    normalizeModelLookupKey(entry.modelRoute.providerModelId),
    normalizeModelLookupKey(entry.runnerModel),
  ]),
);

function looksLikeRawProviderModelId(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (!value) return false;
  if (/^claude-[a-z0-9][a-z0-9._-]*$/.test(value)) return true;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/.test(value);
}

function normalizeModelLookupKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let left = i;
    let diagonal = i - 1;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j] + 1;
      const insert = left + 1;
      const replace = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = prev[j];
      left = Math.min(above, insert, replace);
      prev[j] = left;
    }
  }
  return prev[b.length];
}

const ALIAS_INDEX = buildAliasIndex();
const ID_INDEX = new Map(
  MODEL_CATALOG.map((entry) => [normalizeModelLookupKey(entry.id), entry]),
);
const RUNNER_MODEL_INDEX = new Map(
  MODEL_CATALOG.flatMap((entry) => [
    [normalizeModelLookupKey(entry.runnerModel), entry] as const,
    [normalizeModelLookupKey(entry.modelRoute.providerModelId), entry] as const,
  ]),
);

function buildAliasIndex(): Map<
  string,
  { entry: ModelCatalogEntry; alias: string }
> {
  const aliases = new Map<
    string,
    { entry: ModelCatalogEntry; alias: string }
  >();
  for (const entry of MODEL_CATALOG) {
    for (const alias of entry.aliases) {
      const key = normalizeModelLookupKey(alias);
      const existing = aliases.get(key);
      if (existing && existing.entry.id !== entry.id) {
        throw new Error(`Duplicate model alias: ${alias}`);
      }
      if (!existing) aliases.set(key, { entry, alias });
    }
  }
  return aliases;
}

function suggestModelAlias(input: string): string | undefined {
  const key = normalizeModelLookupKey(input);
  if (!key) return undefined;
  let best:
    | {
        alias: string;
        distance: number;
      }
    | undefined;
  for (const { alias } of ALIAS_INDEX.values()) {
    const distance = levenshtein(key, normalizeModelLookupKey(alias));
    if (!best || distance < best.distance) {
      best = { alias, distance };
    }
  }
  if (!best) return undefined;
  const maxDistance = key.length <= 5 ? 2 : 3;
  return best.distance <= maxDistance ? best.alias : undefined;
}

export function listModelCatalogEntries(): readonly ModelCatalogEntry[] {
  return MODEL_CATALOG;
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
  const resolved = ALIAS_INDEX.get(key);
  if (resolved) {
    return {
      ok: true,
      entry: resolved.entry,
      alias: resolved.alias,
      runnerModel: resolved.entry.runnerModel,
    };
  }

  if (
    ID_INDEX.has(key) ||
    RAW_PROVIDER_MODEL_IDS.has(key) ||
    looksLikeRawProviderModelId(input)
  ) {
    return {
      ok: false,
      input,
      reason: 'raw-provider-id',
      message: `Provider model ID "${input}" is not accepted here. Use a model alias from /models.`,
    };
  }

  const suggestion = suggestModelAlias(input);
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

function workloadLabel(workload: ModelWorkload): string {
  switch (workload) {
    case 'chat':
      return 'chat';
    case 'one_time_job':
      return 'one-time jobs';
    case 'recurring_job':
      return 'recurring jobs';
    case 'memory_extractor':
      return 'memory extraction';
    case 'memory_dreaming':
      return 'memory dreaming';
    case 'memory_consolidation':
      return 'memory consolidation';
  }
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
    message: `Model alias "${resolution.alias}" is not eligible for ${workloadLabel(workload)}. Use /models to view supported workloads.`,
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
  return RUNNER_MODEL_INDEX.get(key) ?? ALIAS_INDEX.get(key)?.entry;
}

export function isOpenRouterModelRoute(entry?: ModelCatalogEntry): boolean {
  return entry?.modelRoute.id === 'openrouter';
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000) {
    return `${tokens / 1_000}k`;
  }
  return String(tokens);
}

export function formatModelDisplay(entry: ModelCatalogEntry): string {
  const experimental = entry.experimental ? ' experimental' : '';
  return `${entry.displayName} (${entry.modelRoute.label}${experimental})`;
}

export function formatModelCatalog(defaults: ModelDefaultAliases = {}): string {
  const lines = [
    'Supported model aliases',
    'Alias | Model | Response family | Route | Status',
    '--- | --- | --- | --- | ---',
  ];
  for (const entry of MODEL_CATALOG) {
    for (const alias of entry.aliases) {
      const badges: string[] = [];
      if (alias === entry.recommendedAlias) badges.push('recommended');
      else badges.push('pinned');
      if (defaults.chat === alias) badges.push('chat default');
      if (defaults.oneTime === alias) badges.push('one-time default');
      if (defaults.recurring === alias) badges.push('recurring default');
      if (defaults.memoryExtractor === alias) badges.push('memory extractor');
      if (defaults.memoryDreaming === alias) badges.push('memory dreaming');
      if (defaults.memoryConsolidation === alias) {
        badges.push('memory consolidation');
      }
      lines.push(
        `${alias} | ${entry.displayName} | ${entry.responseFamily} | ${entry.modelRoute.label} | ${badges.join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}
