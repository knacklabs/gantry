export declare const OBSERVER_MIN_CONFIDENCE = 0.6;
export declare const OBSERVER_MIN_EVIDENCE_COUNT = 1;
export declare const OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD = 0.86;
export type ObserverInsightFloorRejection = 'confidence' | 'evidence_count' | 'exact_insight_duplicate' | 'semantic_insight_duplicate' | 'active_memory_duplicate';
export type ObserverInsightFloorDecision = {
    accepted: true;
} | {
    accepted: false;
    reason: ObserverInsightFloorRejection;
};
export declare function canonicalizeObserverInsightText(value: string): string;
export declare function evaluateObserverInsightFloor(input: {
    confidence: number;
    evidenceCount: number;
    exactInsightDuplicate: boolean;
    semanticInsightDuplicate: boolean;
    activeMemoryDuplicate: boolean;
}): ObserverInsightFloorDecision;
export declare function cosineSimilarity(left: number[], right: number[]): number;
