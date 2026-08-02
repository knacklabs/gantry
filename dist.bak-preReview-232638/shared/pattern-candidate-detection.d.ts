import type { PatternEvidenceRef } from '@gantry/contracts';
/**
 * Pure detection heuristic — the Phase 0 gate. No DB, no clock, no LLM. The
 * dreaming job maps conversation turns to {@link PatternTranscriptTurn}s, then
 * calls {@link detectPatternCandidates}.
 *
 * v1 is deliberately simple (frequency over normalized n-grams + repeated
 * intents), not ML clustering. Build clustering only if this provably
 * under-detects on real data.
 */
/** One recurring natural-language task intent extracted from a transcript. */
export interface PatternTranscriptTurn {
    intent: string;
    /** Message/transcript id, used as an evidence ref. */
    messageId: string;
}
export interface PatternCandidateDraft {
    signature: string;
    outcomeLabel: string;
    shortAsk: string;
    occurrences: number;
    evidenceRefs: PatternEvidenceRef[];
}
export declare function detectPatternCandidates(input: {
    transcriptTurns: PatternTranscriptTurn[];
}): PatternCandidateDraft[];
