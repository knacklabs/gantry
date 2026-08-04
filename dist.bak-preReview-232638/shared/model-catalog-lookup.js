export function normalizeModelLookupKey(value) {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
}
export function createModelCatalogIndexes(entries) {
    const aliasIndex = new Map();
    const idIndex = new Map();
    const exactRunnerModelIndex = new Map();
    const runnerModelIndex = new Map();
    const rawProviderModelIds = new Set();
    for (const entry of entries) {
        const idKey = normalizeModelLookupKey(entry.id);
        const existingId = idIndex.get(idKey);
        if (existingId && existingId.id !== entry.id) {
            throw new Error(`Duplicate model catalog id: ${entry.id}`);
        }
        idIndex.set(idKey, entry);
        for (const alias of entry.aliases) {
            const key = normalizeModelLookupKey(alias);
            const existing = aliasIndex.get(key);
            if (existing && existing.entry.id !== entry.id) {
                throw new Error(`Duplicate model alias: ${alias}`);
            }
            if (!existing)
                aliasIndex.set(key, { entry, alias });
        }
        for (const modelId of [
            entry.runnerModel,
            entry.modelRoute.providerModelId,
        ]) {
            const exactKey = modelId.trim().toLowerCase();
            exactRunnerModelIndex.set(exactKey, entry);
            const key = normalizeModelLookupKey(modelId);
            runnerModelIndex.set(key, entry);
            rawProviderModelIds.add(key);
        }
    }
    return {
        aliasIndex,
        idIndex,
        exactRunnerModelIndex,
        runnerModelIndex,
        rawProviderModelIds,
    };
}
export function suggestModelAlias(input, aliasIndex) {
    const key = normalizeModelLookupKey(input);
    if (!key)
        return undefined;
    let best;
    for (const { alias } of aliasIndex.values()) {
        const distance = levenshtein(key, normalizeModelLookupKey(alias));
        if (!best || distance < best.distance) {
            best = { alias, distance };
        }
    }
    if (!best)
        return undefined;
    const maxDistance = key.length <= 5 ? 2 : 3;
    return best.distance <= maxDistance ? best.alias : undefined;
}
export function modelWorkloadLabel(workload) {
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
function levenshtein(a, b) {
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
