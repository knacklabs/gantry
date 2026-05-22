import {
  findModelByRunnerModel,
  type ModelCatalogEntry,
  type NormalizedCacheProvider,
  type NormalizedCacheStatus,
  type NormalizedModelUsage,
} from './model-catalog.js';
import { nowIso } from './time/datetime.js';

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

function cacheProviderForEntry(
  entry: ModelCatalogEntry | undefined,
): NormalizedCacheProvider {
  if (!entry || entry.cacheMode === 'none') return 'none';
  const promptSuffix = '-prompt';
  if (entry.cacheMode.endsWith(promptSuffix)) {
    return entry.cacheMode.slice(
      0,
      -promptSuffix.length,
    ) as NormalizedCacheProvider;
  }
  return 'none';
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
    const cacheProviderSet = new Set(entries.map(cacheProviderForEntry));
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
      at: nowIso(),
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
      cacheProvider: cacheProviderForEntry(entry),
      cacheStatus: normalizeCacheStatus(
        cacheReadTokens,
        cacheWriteTokens,
        Boolean(entry && entry.cacheMode !== 'none'),
      ),
      at: nowIso(),
    };
  }

  return undefined;
}
