export type ModelProviderId = 'anthropic' | 'openrouter';

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

export interface ModelCatalogEntry {
  id: string;
  provider: ModelProviderId;
  providerLabel: string;
  displayName: string;
  providerModelId: string;
  runnerModel: string;
  aliases: readonly string[];
  recommendedAlias: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cacheMode: ModelCacheMode;
  cacheTokenFields: readonly string[];
  supportsThinking: boolean;
  supportsTools: boolean;
  experimental?: boolean;
}

export interface ModelDefaultAliases {
  chat?: string;
  oneTime?: string;
  recurring?: string;
}

export interface NormalizedModelUsage {
  model?: string;
  provider?: ModelProviderId;
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
        | 'alias-as-profile-id'
        | 'duplicate-alias';
    };

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'anthropic:opus-4.7',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    displayName: 'Opus 4.7',
    providerModelId: 'claude-opus-4-7',
    runnerModel: 'claude-opus-4-7',
    aliases: ['opus', 'opus-4.7'],
    recommendedAlias: 'opus',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    cacheMode: 'anthropic-prompt',
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
  },
  {
    id: 'anthropic:opus-4.6',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    displayName: 'Opus 4.6',
    providerModelId: 'claude-opus-4-6',
    runnerModel: 'claude-opus-4-6',
    aliases: ['opus-4.6'],
    recommendedAlias: 'opus-4.6',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    cacheMode: 'anthropic-prompt',
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
  },
  {
    id: 'anthropic:sonnet-4.6',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    displayName: 'Sonnet 4.6',
    providerModelId: 'claude-sonnet-4-6',
    runnerModel: 'claude-sonnet-4-6',
    aliases: ['sonnet', 'sonnet-4.6'],
    recommendedAlias: 'sonnet',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 64_000,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cacheMode: 'anthropic-prompt',
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
  },
  {
    id: 'anthropic:haiku-4.5',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    displayName: 'Haiku 4.5',
    providerModelId: 'claude-haiku-4-5-20251001',
    runnerModel: 'claude-haiku-4-5-20251001',
    aliases: ['haiku', 'haiku-4.5'],
    recommendedAlias: 'haiku',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    cacheMode: 'anthropic-prompt',
    cacheTokenFields: [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ],
    supportsThinking: false,
    supportsTools: true,
  },
  {
    id: 'openrouter:kimi-k2.6',
    provider: 'openrouter',
    providerLabel: 'OpenRouter',
    displayName: 'Kimi K2.6',
    providerModelId: 'moonshotai/kimi-k2.6',
    runnerModel: 'moonshotai/kimi-k2.6',
    aliases: ['kimi', 'kimi-k2.6', 'kimi 2.6'],
    recommendedAlias: 'kimi',
    contextWindowTokens: 262_142,
    maxOutputTokens: 64_000,
    inputUsdPerMillionTokens: 0.74,
    outputUsdPerMillionTokens: 3.49,
    cacheMode: 'openrouter-provider-prompt',
    cacheTokenFields: [
      'prompt_tokens_details.cached_tokens',
      'prompt_tokens_details.cache_write_tokens',
    ],
    supportsThinking: true,
    supportsTools: true,
    experimental: true,
  },
] as const;

const RAW_PROVIDER_MODEL_IDS = new Set(
  MODEL_CATALOG.map((entry) => normalizeModelLookupKey(entry.providerModelId)),
);

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
    [normalizeModelLookupKey(entry.providerModelId), entry] as const,
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
      if (aliases.has(key)) {
        throw new Error(`Duplicate model alias: ${alias}`);
      }
      aliases.set(key, { entry, alias: entry.recommendedAlias });
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

  if (ID_INDEX.has(key) || RAW_PROVIDER_MODEL_IDS.has(key)) {
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

export function resolveModelProfileSelection(
  value?: string | null,
): ModelResolution {
  const input = value?.trim() ?? '';
  if (!input) {
    return {
      ok: false,
      input,
      reason: 'empty',
      message: 'Model profile ID is required.',
    };
  }

  const key = normalizeModelLookupKey(input);
  const resolved = ID_INDEX.get(key);
  if (resolved) {
    return {
      ok: true,
      entry: resolved,
      alias: resolved.recommendedAlias,
      runnerModel: resolved.runnerModel,
    };
  }

  if (RAW_PROVIDER_MODEL_IDS.has(key)) {
    return {
      ok: false,
      input,
      reason: 'raw-provider-id',
      message: `Provider model ID "${input}" is not accepted here. Use a modelProfileId from /models.`,
    };
  }

  if (ALIAS_INDEX.has(key)) {
    return {
      ok: false,
      input,
      reason: 'alias-as-profile-id',
      message: `Model alias "${input}" is not accepted as modelProfileId. Use modelAlias for aliases.`,
    };
  }

  return {
    ok: false,
    input,
    reason: 'unknown',
    message: `Unknown model profile ID "${input}". Use /models to view supported models.`,
  };
}

export function resolveModelAlias(value?: string | null): string | undefined {
  const resolved = resolveModelSelection(value);
  return resolved.ok ? resolved.alias : undefined;
}

export function resolveRunnerModel(value?: string | null): string | undefined {
  const resolved = resolveModelSelection(value);
  return resolved.ok ? resolved.runnerModel : undefined;
}

export function resolveCatalogRunnerModel(
  value?: string | null,
): string | undefined {
  return (
    resolveRunnerModel(value) ?? findModelByRunnerModel(value)?.runnerModel
  );
}

export function findModelByRunnerModel(
  value?: string | null,
): ModelCatalogEntry | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const key = normalizeModelLookupKey(trimmed);
  return RUNNER_MODEL_INDEX.get(key) ?? ALIAS_INDEX.get(key)?.entry;
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
  return `${entry.displayName} (${entry.providerLabel}${experimental})`;
}

export function formatModelCatalog(defaults: ModelDefaultAliases = {}): string {
  const lines = ['Supported models'];
  for (const entry of MODEL_CATALOG) {
    const badges: string[] = [];
    if (defaults.chat === entry.recommendedAlias) badges.push('chat default');
    if (defaults.oneTime === entry.recommendedAlias) {
      badges.push('one-time default');
    }
    if (defaults.recurring === entry.recommendedAlias) {
      badges.push('recurring default');
    }
    const aliasList = entry.aliases
      .slice(0, 2)
      .map((alias) => `"${alias}"`)
      .join(', ');
    const cache =
      entry.cacheMode === 'none' ? 'cache: none' : `cache: ${entry.cacheMode}`;
    lines.push(
      `${entry.displayName} - use ${aliasList}; ${entry.providerLabel}; context ${formatTokenCount(entry.contextWindowTokens)}; max output ${formatTokenCount(entry.maxOutputTokens)}; ${cache}${badges.length ? `; ${badges.join(', ')}` : ''}`,
    );
  }
  return lines.join('\n');
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeCacheStatus(
  read: number,
  write: number,
  supported: boolean,
): NormalizedCacheStatus {
  if (!supported) return 'unsupported';
  if (read > 0 && write > 0) return 'partial';
  if (read > 0) return 'hit';
  if (write > 0) return 'miss';
  return 'unknown';
}

export function normalizeModelUsage(input: {
  message: unknown;
  fallbackModel?: string;
}): NormalizedModelUsage | undefined {
  const result = input.message as {
    total_cost_usd?: number;
    modelUsage?: Record<
      string,
      {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        costUSD?: number;
      }
    >;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
      };
    };
  };

  if (result.modelUsage && Object.keys(result.modelUsage).length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let estimatedCostUsd = 0;
    const modelNames = Object.keys(result.modelUsage);
    const firstModel = modelNames[0] ?? input.fallbackModel;
    const entries = modelNames
      .map((model) => findModelByRunnerModel(model))
      .filter((entry): entry is ModelCatalogEntry => Boolean(entry));
    const providerSet = new Set(entries.map((entry) => entry.provider));
    const cacheProviderSet = new Set(
      entries.map((entry) =>
        entry.provider === 'openrouter' ? 'openrouter-provider' : 'anthropic',
      ),
    );
    const hasUnknownModel = entries.length !== modelNames.length;
    for (const usage of Object.values(result.modelUsage)) {
      inputTokens += numeric(usage.inputTokens);
      outputTokens += numeric(usage.outputTokens);
      cacheReadTokens += numeric(usage.cacheReadInputTokens);
      cacheWriteTokens += numeric(usage.cacheCreationInputTokens);
      estimatedCostUsd += numeric(usage.costUSD);
    }
    const entry = findModelByRunnerModel(firstModel ?? input.fallbackModel);
    const isMixedModel = modelNames.length > 1;
    return {
      model: isMixedModel ? 'mixed' : (entry?.recommendedAlias ?? firstModel),
      provider:
        providerSet.size === 1
          ? [...providerSet][0]
          : isMixedModel
            ? undefined
            : entry?.provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalBillableInputTokens: Math.max(0, inputTokens - cacheReadTokens),
      estimatedCostUsd:
        estimatedCostUsd > 0 ? estimatedCostUsd : result.total_cost_usd,
      cacheProvider: hasUnknownModel
        ? 'none'
        : cacheProviderSet.size === 1
          ? [...cacheProviderSet][0]
          : 'mixed',
      cacheStatus: normalizeCacheStatus(
        cacheReadTokens,
        cacheWriteTokens,
        !hasUnknownModel,
      ),
      at: new Date().toISOString(),
    };
  }

  if (result.usage) {
    const entry = findModelByRunnerModel(input.fallbackModel);
    const inputTokens =
      numeric(result.usage.input_tokens) || numeric(result.usage.prompt_tokens);
    const outputTokens =
      numeric(result.usage.output_tokens) ||
      numeric(result.usage.completion_tokens);
    const cacheReadTokens = numeric(
      result.usage.prompt_tokens_details?.cached_tokens,
    );
    const cacheWriteTokens = numeric(
      result.usage.prompt_tokens_details?.cache_write_tokens,
    );
    return {
      model: entry?.recommendedAlias ?? input.fallbackModel,
      provider: entry?.provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalBillableInputTokens: Math.max(0, inputTokens - cacheReadTokens),
      cacheProvider:
        entry?.provider === 'openrouter' ? 'openrouter-provider' : 'none',
      cacheStatus: normalizeCacheStatus(
        cacheReadTokens,
        cacheWriteTokens,
        Boolean(entry && entry.cacheMode !== 'none'),
      ),
      at: new Date().toISOString(),
    };
  }

  return undefined;
}
