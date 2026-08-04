import { canonicalizeObserverInsightText } from '../shared/observer-insight-policy.js';
export async function loadCanonicalActiveMemoryValues(input) {
    const rows = await input.memory.listActiveValues(input);
    const values = new Set();
    for (const row of rows) {
        const value = canonicalizeObserverInsightText(row);
        if (value)
            values.add(value);
    }
    return values;
}
export async function hasExactActiveMemoryMatch(input) {
    const candidate = canonicalizeObserverInsightText(input.candidateText);
    if (!candidate)
        return false;
    const values = await loadCanonicalActiveMemoryValues(input);
    return values.has(candidate);
}
