import { nowIso } from '../shared/time/datetime.js';
const snapshots = new Map();
const seenUsageKeys = new Map();
const MAX_RUNTIME_MODEL_STATUS_SNAPSHOTS = 500;
const MAX_USAGE_KEYS_PER_STATUS = 200;
function emptyUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalBillableInputTokens: 0,
        cacheProvider: 'none',
        cacheStatus: 'unknown',
        at: nowIso(),
    };
}
function statusKey(scopeKey, threadId) {
    return `${scopeKey}:${threadId ?? ''}`;
}
export function updateRuntimeModelStatus(input) {
    const key = statusKey(input.scopeKey, input.threadId);
    const existing = snapshots.get(key);
    if (existing)
        snapshots.delete(key);
    const cumulative = existing?.cumulativeUsage ?? emptyUsage();
    const usageKey = input.usageKey;
    const usageAlreadySeen = usageKey !== undefined && seenUsageKeys.get(key)?.has(usageKey);
    if (input.usage && !usageAlreadySeen) {
        if (usageKey !== undefined) {
            const seen = seenUsageKeys.get(key) ?? new Set();
            seen.add(usageKey);
            while (seen.size > MAX_USAGE_KEYS_PER_STATUS) {
                const oldest = seen.values().next().value;
                if (!oldest)
                    break;
                seen.delete(oldest);
            }
            seenUsageKeys.set(key, seen);
        }
        cumulative.inputTokens += input.usage.inputTokens;
        cumulative.outputTokens += input.usage.outputTokens;
        cumulative.cacheReadTokens += input.usage.cacheReadTokens;
        cumulative.cacheWriteTokens += input.usage.cacheWriteTokens;
        cumulative.totalBillableInputTokens += input.usage.totalBillableInputTokens;
        if (typeof input.usage.estimatedCostUsd === 'number' ||
            typeof cumulative.estimatedCostUsd === 'number') {
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
        if (!oldest)
            break;
        snapshots.delete(oldest);
        seenUsageKeys.delete(oldest);
    }
}
export function getRuntimeModelStatus(input) {
    return snapshots.get(statusKey(input.scopeKey, input.threadId));
}
export function createRuntimeModelStatusAccess(scopeKey, threadId) {
    return {
        getStatus: () => getRuntimeModelStatus({ scopeKey, threadId }),
        updateSelection: (input) => updateRuntimeModelStatus({ scopeKey, threadId, ...input }),
    };
}
