import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildProactiveSurfacingMetricPayloads,
  outcomeForPatternCandidateStatus,
} from '@core/runtime/proactive-surfacing-metrics.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('proactive surfacing metrics', () => {
  it('scrubs the subject id and keeps only stable candidate dimensions', () => {
    const subjectId = 'conversation:sl:C123';

    const [payload] = buildProactiveSurfacingMetricPayloads({
      subjectId,
      candidates: [{ signature: 'sig_stable_hash', status: 'suggested' }],
      outcome: 'surfaced',
    });

    expect(payload).toEqual({
      subjectHash: sha256Hex(subjectId),
      candidateSignature: 'sig_stable_hash',
      outcome: 'surfaced',
    });
    const serialized = JSON.stringify(payload);
    expect(payload?.subjectHash).not.toBe(subjectId);
    expect(serialized).not.toContain(subjectId);
    expect(serialized).not.toContain('sl:C123');
    expect(serialized).not.toContain('outcomeLabel');
    expect(serialized).not.toContain('shortAsk');
    expect(serialized).not.toContain('suggested');
  });

  it('maps candidate statuses to outcome labels', () => {
    expect(outcomeForPatternCandidateStatus('accepted')).toBe('accepted');
    expect(outcomeForPatternCandidateStatus('dismissed')).toBe('dismissed');
    expect(outcomeForPatternCandidateStatus('suggested')).toBe('surfaced');
    expect(outcomeForPatternCandidateStatus('detected')).toBe('surfaced');
    expect(outcomeForPatternCandidateStatus('snoozed')).toBe('surfaced');
    expect(outcomeForPatternCandidateStatus(undefined)).toBe('surfaced');
  });

  it('emits fail-closed outcomes without a candidate signature', () => {
    const [payload] = buildProactiveSurfacingMetricPayloads({
      subjectId: 'U123',
      candidates: [],
      outcome: 'opt_in_unavailable',
    });

    expect(payload).toEqual({
      subjectHash: sha256Hex('U123'),
      outcome: 'opt_in_unavailable',
    });
    expect(payload).not.toHaveProperty('candidateSignature');
  });
});
