import { describe, expect, it } from 'vitest';

import { isObserverSubjectKey } from '@core/domain/ports/observer-insights.js';

import {
  OBSERVER_MIN_CONFIDENCE,
  OBSERVER_MIN_EVIDENCE_COUNT,
  OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD,
  canonicalizeObserverInsightText,
  cosineSimilarity,
  evaluateObserverInsightFloor,
} from '@core/shared/observer-insight-policy.js';

const PASSING_INPUT = {
  confidence: OBSERVER_MIN_CONFIDENCE,
  evidenceCount: OBSERVER_MIN_EVIDENCE_COUNT,
  exactInsightDuplicate: false,
  semanticInsightDuplicate: false,
  activeMemoryDuplicate: false,
};

describe('observer insight policy', () => {
  it('exposes and enforces the Stage 2 floors', () => {
    expect(OBSERVER_MIN_CONFIDENCE).toBe(0.6);
    expect(OBSERVER_MIN_EVIDENCE_COUNT).toBe(1);
    expect(OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD).toBe(0.86);
    expect(evaluateObserverInsightFloor(PASSING_INPUT)).toEqual({
      accepted: true,
    });
    expect(
      evaluateObserverInsightFloor({ ...PASSING_INPUT, confidence: 0.599 }),
    ).toEqual({ accepted: false, reason: 'confidence' });
    expect(
      evaluateObserverInsightFloor({ ...PASSING_INPUT, evidenceCount: 0 }),
    ).toEqual({ accepted: false, reason: 'evidence_count' });
  });

  it.each([
    ['exactInsightDuplicate', 'exact_insight_duplicate'],
    ['semanticInsightDuplicate', 'semantic_insight_duplicate'],
    ['activeMemoryDuplicate', 'active_memory_duplicate'],
  ] as const)('rejects %s', (field, reason) => {
    expect(
      evaluateObserverInsightFloor({ ...PASSING_INPUT, [field]: true }),
    ).toEqual({ accepted: false, reason });
  });

  it('canonicalizes with NFKC, lowercase, punctuation spaces, and collapsed whitespace', () => {
    expect(canonicalizeObserverInsightText('  ＴＥＡＭ—Update!!!\nNow  ')).toBe(
      'team update now',
    );
  });

  it('computes cosine similarity for in-run comparisons', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(
      cosineSimilarity(
        [1, 0],
        [
          OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD,
          Math.sqrt(1 - OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD ** 2),
        ],
      ),
    ).toBeCloseTo(OBSERVER_SEMANTIC_DEDUP_COSINE_THRESHOLD);
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
  });

  it('accepts only legacy, source-conversation, and app fallback subjects', () => {
    expect(isObserverSubjectKey('msu_11111111111111111111111111111111')).toBe(
      true,
    );
    expect(isObserverSubjectKey('conversation:sl:C111')).toBe(true);
    expect(isObserverSubjectKey('observer:app')).toBe(true);
    expect(isObserverSubjectKey('owner-1')).toBe(false);
    expect(isObserverSubjectKey('conversation:   ')).toBe(false);
    expect(
      isObserverSubjectKey(`conversation:sl:C111${String.fromCharCode(10)}x`),
    ).toBe(false);
  });
});
