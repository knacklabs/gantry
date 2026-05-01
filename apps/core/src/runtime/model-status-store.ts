import type {
  ModelCatalogEntry,
  NormalizedModelUsage,
} from '../shared/model-catalog.js';

export interface RuntimeModelStatusSnapshot {
  scopeKey: string;
  threadId?: string | null;
  selectionSource: string;
  modelAlias?: string;
  model?: ModelCatalogEntry;
  lastUsage?: NormalizedModelUsage;
  cumulativeUsage: NormalizedModelUsage;
}

const snapshots = new Map<string, RuntimeModelStatusSnapshot>();

function emptyUsage(): NormalizedModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalBillableInputTokens: 0,
    cacheProvider: 'none',
    cacheStatus: 'unknown',
    at: new Date().toISOString(),
  };
}

function statusKey(scopeKey: string, threadId?: string | null): string {
  return `${scopeKey}:${threadId ?? ''}`;
}

export function updateRuntimeModelStatus(input: {
  scopeKey: string;
  threadId?: string | null;
  selectionSource: string;
  modelAlias?: string;
  model?: ModelCatalogEntry;
  usage?: NormalizedModelUsage;
}): void {
  const key = statusKey(input.scopeKey, input.threadId);
  const existing = snapshots.get(key);
  const cumulative = existing?.cumulativeUsage ?? emptyUsage();
  if (input.usage) {
    cumulative.inputTokens += input.usage.inputTokens;
    cumulative.outputTokens += input.usage.outputTokens;
    cumulative.cacheReadTokens += input.usage.cacheReadTokens;
    cumulative.cacheWriteTokens += input.usage.cacheWriteTokens;
    cumulative.totalBillableInputTokens += input.usage.totalBillableInputTokens;
    if (
      typeof input.usage.estimatedCostUsd === 'number' ||
      typeof cumulative.estimatedCostUsd === 'number'
    ) {
      cumulative.estimatedCostUsd =
        (cumulative.estimatedCostUsd ?? 0) +
        (input.usage.estimatedCostUsd ?? 0);
    }
    cumulative.cacheProvider = input.usage.cacheProvider;
    cumulative.cacheStatus = input.usage.cacheStatus;
    cumulative.model = input.usage.model;
    cumulative.provider = input.usage.provider;
    cumulative.at = input.usage.at;
  }

  snapshots.set(key, {
    scopeKey: input.scopeKey,
    threadId: input.threadId,
    selectionSource: input.selectionSource,
    modelAlias: input.modelAlias ?? existing?.modelAlias,
    model: input.model ?? existing?.model,
    lastUsage: input.usage ?? existing?.lastUsage,
    cumulativeUsage: cumulative,
  });
}

export function getRuntimeModelStatus(input: {
  scopeKey: string;
  threadId?: string | null;
}): RuntimeModelStatusSnapshot | undefined {
  return snapshots.get(statusKey(input.scopeKey, input.threadId));
}
