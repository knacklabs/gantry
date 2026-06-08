import {
  findModelByRunnerModel,
  type ModelCatalogEntry,
  type NormalizedCacheStatus,
  type NormalizedModelUsage,
} from './model-catalog.js';
import {
  resolveModelCacheProvider,
  resolveModelCacheSupport,
} from './model-cache-support.js';
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

function readPath(input: unknown, path?: string): unknown {
  if (!path) return undefined;
  let cursor = input;
  for (const segment of path.split('.')) {
    if (!segment) return undefined;
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
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
    usage?: Record<string, unknown> & {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: Record<string, unknown>;
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
    const responseFamilySet = new Set(
      entries.map((entry) => entry.responseFamily),
    );
    const modelRouteSet = new Set(entries.map((entry) => entry.modelRoute.id));
    const cacheProviderSet = new Set(entries.map(resolveModelCacheProvider));
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
    const cacheProvider = hasUnknownModel
      ? 'none'
      : cacheProviderSet.size === 1
        ? [...cacheProviderSet][0]
        : 'mixed';
    const supportsCacheAccounting =
      cacheProvider !== 'none' && cacheProviderSet.size > 0;
    return {
      model: isMixedModel ? 'mixed' : (entry?.recommendedAlias ?? firstModel),
      responseFamily:
        responseFamilySet.size === 1
          ? [...responseFamilySet][0]
          : isMixedModel
            ? undefined
            : entry?.responseFamily,
      modelRoute:
        modelRouteSet.size === 1
          ? [...modelRouteSet][0]
          : isMixedModel
            ? undefined
            : entry?.modelRoute.id,
      provider:
        modelRouteSet.size === 1
          ? [...modelRouteSet][0]
          : isMixedModel
            ? undefined
            : entry?.modelRoute.id,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalBillableInputTokens: supportsCacheAccounting
        ? Math.max(0, inputTokens - cacheReadTokens)
        : inputTokens,
      estimatedCostUsd:
        estimatedCostUsd > 0 ? estimatedCostUsd : result.total_cost_usd,
      cacheProvider,
      cacheStatus: normalizeCacheStatus(
        cacheReadTokens,
        cacheWriteTokens,
        supportsCacheAccounting,
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
    const cacheProvider = resolveModelCacheProvider(entry);
    const supportsCacheAccounting = cacheProvider !== 'none';
    const usageFields = entry
      ? resolveModelCacheSupport(entry).prompt.usageFields
      : undefined;
    const cacheReadTokens = numeric(
      readPath(result.usage, usageFields?.readTokens),
    );
    const cacheWriteTokens = numeric(
      readPath(result.usage, usageFields?.writeTokens),
    );
    return {
      model: entry?.recommendedAlias ?? input.fallbackModel,
      responseFamily: entry?.responseFamily,
      modelRoute: entry?.modelRoute.id,
      provider: entry?.modelRoute.id,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalBillableInputTokens: supportsCacheAccounting
        ? Math.max(0, inputTokens - cacheReadTokens)
        : inputTokens,
      cacheProvider,
      cacheStatus: normalizeCacheStatus(
        cacheReadTokens,
        cacheWriteTokens,
        supportsCacheAccounting,
      ),
      at: nowIso(),
    };
  }

  return undefined;
}
