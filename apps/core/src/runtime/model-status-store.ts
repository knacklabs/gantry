import type {
  ModelCatalogEntry,
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../shared/model-catalog.js';

export interface RuntimeModelStatusSnapshot {
  scopeKey: string;
  threadId?: string | null;
  selectionSource: string;
  modelAlias?: string;
  model?: ModelCatalogEntry;
  contextUsage?: RuntimeContextUsageSnapshot;
  lastUsage?: NormalizedModelUsage;
  cumulativeUsage: NormalizedModelUsage;
}

const snapshots = new Map<string, RuntimeModelStatusSnapshot>();
const seenUsageKeys = new Map<string, Set<string>>();
const MAX_RUNTIME_MODEL_STATUS_SNAPSHOTS = 500;
const MAX_USAGE_KEYS_PER_STATUS = 200;

export interface RuntimeModelStatusSelectionUpdate {
  selectionSource: string;
  modelAlias?: string;
  model?: ModelCatalogEntry;
  contextUsage?: RuntimeContextUsageSnapshot;
}

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
  contextUsage?: RuntimeContextUsageSnapshot;
  usage?: NormalizedModelUsage;
  usageKey?: string;
}): void {
  const key = statusKey(input.scopeKey, input.threadId);
  const existing = snapshots.get(key);
  if (existing) snapshots.delete(key);
  const cumulative = existing?.cumulativeUsage ?? emptyUsage();
  const usageKey = input.usageKey;
  const usageAlreadySeen =
    usageKey !== undefined && seenUsageKeys.get(key)?.has(usageKey);
  if (input.usage && !usageAlreadySeen) {
    if (usageKey !== undefined) {
      const seen = seenUsageKeys.get(key) ?? new Set<string>();
      seen.add(usageKey);
      while (seen.size > MAX_USAGE_KEYS_PER_STATUS) {
        const oldest = seen.values().next().value;
        if (!oldest) break;
        seen.delete(oldest);
      }
      seenUsageKeys.set(key, seen);
    }
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
    contextUsage: input.contextUsage ?? existing?.contextUsage,
    lastUsage: input.usage ?? existing?.lastUsage,
    cumulativeUsage: cumulative,
  });
  while (snapshots.size > MAX_RUNTIME_MODEL_STATUS_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (!oldest) break;
    snapshots.delete(oldest);
    seenUsageKeys.delete(oldest);
  }
}

export function getRuntimeModelStatus(input: {
  scopeKey: string;
  threadId?: string | null;
}): RuntimeModelStatusSnapshot | undefined {
  return snapshots.get(statusKey(input.scopeKey, input.threadId));
}

export function createRuntimeModelStatusAccess(
  scopeKey: string,
  threadId?: string | null,
): {
  getStatus: () => RuntimeModelStatusSnapshot | undefined;
  updateSelection: (input: RuntimeModelStatusSelectionUpdate) => void;
} {
  return {
    getStatus: () => getRuntimeModelStatus({ scopeKey, threadId }),
    updateSelection: (input) =>
      updateRuntimeModelStatus({ scopeKey, threadId, ...input }),
  };
}
