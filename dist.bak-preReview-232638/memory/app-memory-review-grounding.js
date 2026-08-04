const GROUNDING_STOP_WORDS = new Set([
    'about',
    'after',
    'also',
    'because',
    'before',
    'from',
    'have',
    'into',
    'must',
    'need',
    'needs',
    'only',
    'that',
    'their',
    'them',
    'this',
    'with',
]);
function significantGroundingTokens(value) {
    const tokens = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g);
    if (!tokens)
        return [];
    return [...new Set(tokens)].filter((token) => !GROUNDING_STOP_WORDS.has(token));
}
export function isValueGroundedInEvidence(value, evidenceRows) {
    const valueTokens = significantGroundingTokens(value);
    if (!valueTokens.length)
        return false;
    const corpusTokens = new Set(evidenceRows.flatMap((evidence) => significantGroundingTokens(evidence.text)));
    const hits = valueTokens.filter((token) => corpusTokens.has(token)).length;
    const required = valueTokens.length <= 3
        ? valueTokens.length
        : Math.ceil(valueTokens.length * 0.5);
    return hits >= required;
}
