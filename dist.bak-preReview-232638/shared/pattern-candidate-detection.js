import { createHash } from 'node:crypto';
import { PATTERN_DETECTION_MIN_OCCURRENCES, PATTERN_MAX_CANDIDATES_PER_RUN, } from './pattern-candidate-policy.js';
const MAX_EVIDENCE_PER_CANDIDATE = 25;
function normalizeIntent(intent) {
    return intent.trim().toLowerCase().replace(/\s+/g, ' ');
}
function signatureFor(kind, key) {
    return createHash('sha256')
        .update(`${kind}:${key}`)
        .digest('hex')
        .slice(0, 32);
}
function ensureEntry(acc, seed) {
    const existing = acc.get(seed.signature);
    if (existing)
        return existing;
    const created = {
        ...seed,
        occurrences: 0,
        evidenceIds: new Set(),
    };
    acc.set(seed.signature, created);
    return created;
}
export function detectPatternCandidates(input) {
    const acc = new Map();
    // Repeated natural-language intents.
    for (const turn of input.transcriptTurns) {
        const normalized = normalizeIntent(turn.intent);
        if (!normalized)
            continue;
        const label = turn.intent.trim();
        const entry = ensureEntry(acc, {
            signature: signatureFor('intent', normalized),
            evidenceKind: 'transcript',
            outcomeLabel: label,
            shortAsk: label,
        });
        entry.occurrences += 1;
        entry.evidenceIds.add(turn.messageId);
    }
    return [...acc.values()]
        .filter((entry) => entry.occurrences >= PATTERN_DETECTION_MIN_OCCURRENCES)
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, PATTERN_MAX_CANDIDATES_PER_RUN)
        .map((entry) => ({
        signature: entry.signature,
        outcomeLabel: entry.outcomeLabel,
        shortAsk: entry.shortAsk,
        occurrences: entry.occurrences,
        evidenceRefs: [...entry.evidenceIds]
            .slice(0, MAX_EVIDENCE_PER_CANDIDATE)
            .map((id) => ({ kind: entry.evidenceKind, id })),
    }));
}
