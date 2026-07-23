export const OBSERVER_MIN_CONFIDENCE = 0.6;
export const OBSERVER_MIN_EVIDENCE_COUNT = 1;
export const OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD = 0.86;

export type ObserverInsightFloorRejection =
  | 'confidence'
  | 'evidence_count'
  | 'exact_insight_duplicate'
  | 'semantic_insight_duplicate'
  | 'active_memory_duplicate';

export type ObserverInsightFloorDecision =
  | { accepted: true }
  | { accepted: false; reason: ObserverInsightFloorRejection };

export function canonicalizeObserverInsightText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evaluateObserverInsightFloor(input: {
  confidence: number;
  evidenceCount: number;
  exactInsightDuplicate: boolean;
  semanticInsightDuplicate: boolean;
  activeMemoryDuplicate: boolean;
}): ObserverInsightFloorDecision {
  if (input.confidence < OBSERVER_MIN_CONFIDENCE) {
    return { accepted: false, reason: 'confidence' };
  }
  if (input.evidenceCount < OBSERVER_MIN_EVIDENCE_COUNT) {
    return { accepted: false, reason: 'evidence_count' };
  }
  if (input.exactInsightDuplicate) {
    return { accepted: false, reason: 'exact_insight_duplicate' };
  }
  if (input.semanticInsightDuplicate) {
    return { accepted: false, reason: 'semantic_insight_duplicate' };
  }
  if (input.activeMemoryDuplicate) {
    return { accepted: false, reason: 'active_memory_duplicate' };
  }
  return { accepted: true };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;

  const similarity = dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
  return Math.max(-1, Math.min(1, similarity));
}
