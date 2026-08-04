import { listModelCatalogEntries, resolveModelSelection, } from './model-catalog.js';
import { resolveExecutionRoute } from './model-execution-route.js';
export function recommendModelAlias(input) {
    const priority = input.priority ?? 'balanced';
    const rejected = [];
    const currentEntry = resolveCurrentEntry(input.currentAlias, rejected);
    const candidates = [];
    for (const entry of listModelCatalogEntries()) {
        const alias = currentEntry?.entry.id === entry.id && currentEntry.alias
            ? currentEntry.alias
            : entry.recommendedAlias;
        const rejection = rejectCandidate(entry, input);
        if (rejection) {
            rejected.push({ alias, reason: rejection });
            continue;
        }
        candidates.push(candidateForEntry(entry, alias, input, currentEntry));
    }
    candidates.sort((a, b) => compareCandidates(a, b, priority));
    const selected = candidates[0];
    if (!selected)
        return undefined;
    return {
        alias: selected.alias,
        reason: reasonForCandidate(selected, input),
        entry: selected.entry,
        rejected,
    };
}
function resolveCurrentEntry(alias, rejected) {
    const value = alias?.trim();
    if (!value)
        return undefined;
    const resolved = resolveModelSelection(value);
    if (resolved.ok) {
        return { entry: resolved.entry, alias: resolved.alias };
    }
    rejected.push({ alias: value, reason: resolved.message });
    return undefined;
}
function rejectCandidate(entry, input) {
    if (!entry.supportedWorkloads.includes(input.workload)) {
        return `unsupported workload ${input.workload}`;
    }
    const route = resolveExecutionRoute({
        entry,
        agentHarness: input.agentHarness,
    });
    if (!route.ok)
        return route.message;
    if (input.requiresTools &&
        !(entry.supportsTools ?? entry.capabilities.toolUse)) {
        return 'tools required';
    }
    const estimated = input.estimatedContextTokens;
    if (typeof estimated === 'number' &&
        Number.isFinite(estimated) &&
        estimated > 0 &&
        typeof entry.contextWindowTokens === 'number' &&
        entry.contextWindowTokens < estimated) {
        return `context window ${entry.contextWindowTokens} below estimated ${estimated}`;
    }
    return undefined;
}
function candidateForEntry(entry, alias, input, currentEntry) {
    const ready = input.configuredProviders === undefined ||
        input.configuredProviders.has(entry.modelRoute.id);
    const knownPrice = typeof entry.inputUsdPerMillionTokens === 'number' &&
        typeof entry.outputUsdPerMillionTokens === 'number';
    const estimated = input.estimatedContextTokens ?? 0;
    return {
        entry,
        alias,
        ready,
        current: currentEntry?.entry.id === entry.id,
        knownPrice,
        price: knownPrice
            ? entry.inputUsdPerMillionTokens + entry.outputUsdPerMillionTokens
            : Number.POSITIVE_INFINITY,
        contextFit: typeof entry.contextWindowTokens === 'number'
            ? Math.max(entry.contextWindowTokens - estimated, 0)
            : 0,
        strength: (entry.supportsThinking ? 3 : 0) +
            ((entry.supportsTools ?? entry.capabilities.toolUse) ? 2 : 0) +
            (entry.maxOutputTokens ? Math.min(entry.maxOutputTokens / 64_000, 2) : 0),
    };
}
function compareCandidates(a, b, priority) {
    const ready = Number(b.ready) - Number(a.ready);
    if (ready !== 0)
        return ready;
    if (priority === 'cheap') {
        return comparePriceThenCurrent(a, b);
    }
    if (priority === 'best') {
        return compareStrengthThenCurrent(a, b);
    }
    const knownPrice = Number(b.knownPrice) - Number(a.knownPrice);
    if (knownPrice !== 0)
        return knownPrice;
    const context = b.contextFit - a.contextFit;
    if (context !== 0)
        return context;
    return comparePriceThenCurrent(a, b);
}
function comparePriceThenCurrent(a, b) {
    const price = a.price - b.price;
    if (price !== 0)
        return price;
    const current = Number(b.current) - Number(a.current);
    if (current !== 0)
        return current;
    const strength = b.strength - a.strength;
    if (strength !== 0)
        return strength;
    return a.alias.localeCompare(b.alias);
}
function compareStrengthThenCurrent(a, b) {
    const strength = b.strength - a.strength;
    if (strength !== 0)
        return strength;
    const current = Number(b.current) - Number(a.current);
    if (current !== 0)
        return current;
    if (a.knownPrice && b.knownPrice) {
        const premium = b.price - a.price;
        if (premium !== 0)
            return premium;
    }
    return comparePriceThenCurrent(a, b);
}
function reasonForCandidate(candidate, input) {
    const parts = [`supports ${input.workload}`];
    if (input.agentHarness)
        parts.push(`compatible with ${input.agentHarness}`);
    if (input.configuredProviders) {
        parts.push(candidate.ready
            ? 'provider credential ready'
            : 'provider credential missing');
    }
    if (candidate.knownPrice) {
        parts.push(`known cost $${trimPrice(candidate.price)} per 1M in+out`);
    }
    else {
        parts.push('unknown cost');
    }
    if (input.estimatedContextTokens && candidate.entry.contextWindowTokens) {
        parts.push(`context fits ${input.estimatedContextTokens} tokens`);
    }
    if (candidate.current)
        parts.push('keeps current alias');
    return parts.join('; ');
}
function trimPrice(value) {
    return value
        .toFixed(3)
        .replace(/\.?0+$/, '')
        .replace(/^$/, '0');
}
