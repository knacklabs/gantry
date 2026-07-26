import { describe, expect, it } from 'vitest';

import { buildObserverDigestMessageView } from '@core/domain/observer-digest-view.js';
import type { ObserverFeedbackAction } from '@core/domain/message-actions.js';

const EXPECTED_ACTIONS: ObserverFeedbackAction[] = [
  'resolve',
  'dismiss',
  'snooze',
  'less_like_this',
];

describe('buildObserverDigestMessageView', () => {
  it('produces ordered insights, each with the 4 feedback affordances', () => {
    const view = buildObserverDigestMessageView({
      localDay: '2026-07-25',
      recipient: 'owner-1',
      insights: [
        {
          id: 'ins-a',
          title: 'A title',
          summary: 'A summary',
          insightType: 'commitment',
        },
        {
          id: 'ins-b',
          title: 'B title',
          summary: 'B summary',
          insightType: 'contradiction',
        },
      ],
    });

    expect(view.localDay).toBe('2026-07-25');
    expect(view.recipient).toBe('owner-1');
    // Order preserved.
    expect(view.insights.map((i) => i.insightId)).toEqual(['ins-a', 'ins-b']);

    for (const insight of view.insights) {
      expect(insight.affordances).toHaveLength(4);
      // Every affordance is observer_feedback and carries its own insightId.
      expect(insight.affordances.map((a) => a.action)).toEqual(
        EXPECTED_ACTIONS,
      );
      for (const affordance of insight.affordances) {
        expect(affordance.kind).toBe('observer_feedback');
        expect(affordance.insightId).toBe(insight.insightId);
        expect(affordance.label.length).toBeGreaterThan(0);
        // localDay is stamped so the callback token can pin its exact digest.
        expect(affordance.localDay).toBe(view.localDay);
      }
    }

    expect(view.insights[0]).toMatchObject({
      title: 'A title',
      summary: 'A summary',
      type: 'commitment',
    });
  });

  it('truncates over-long title and summary with an ellipsis', () => {
    const view = buildObserverDigestMessageView({
      localDay: '2026-07-25',
      recipient: 'owner-1',
      insights: [
        {
          id: 'ins-a',
          title: 'T'.repeat(5000),
          summary: 'S'.repeat(5000),
          insightType: 'commitment',
        },
      ],
    });
    const insight = view.insights[0]!;
    expect(insight.title.length).toBeLessThanOrEqual(160);
    expect(insight.summary.length).toBeLessThanOrEqual(800);
    expect(insight.title.endsWith('…')).toBe(true);
    expect(insight.summary.endsWith('…')).toBe(true);
  });

  it('truncates on whole code points so an emoji at the cap is not split into a lone surrogate', () => {
    // Emoji straddles the UTF-16 cut boundary: a naive slice(0, max-1) would keep
    // a lone high surrogate. 158 'a's put an emoji across UTF-16 indices 158/159.
    const title = 'a'.repeat(158) + '😀😀😀😀';
    const summary = 'b'.repeat(798) + '😀😀😀😀';
    const view = buildObserverDigestMessageView({
      localDay: '2026-07-25',
      recipient: 'owner-1',
      insights: [{ id: 'ins-a', title, summary, insightType: 'commitment' }],
    });
    for (const field of [view.insights[0]!.title, view.insights[0]!.summary]) {
      // No lone high surrogate (high not followed by a low).
      expect(field).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      // No replacement char, and a UTF-8 round-trip is lossless.
      expect(field).not.toContain('�');
      expect(Buffer.from(field, 'utf8').toString('utf8')).toBe(field);
      expect(field.endsWith('…')).toBe(true);
    }
  });

  it('leaves short title and summary untouched', () => {
    const view = buildObserverDigestMessageView({
      localDay: '2026-07-25',
      recipient: 'owner-1',
      insights: [
        {
          id: 'ins-a',
          title: 'Short',
          summary: 'Also short',
          insightType: 'commitment',
        },
      ],
    });
    expect(view.insights[0]!.title).toBe('Short');
    expect(view.insights[0]!.summary).toBe('Also short');
  });

  it('returns an empty insight list for an empty selection', () => {
    const view = buildObserverDigestMessageView({
      localDay: '2026-07-25',
      recipient: 'owner-1',
      insights: [],
    });
    expect(view.insights).toEqual([]);
  });
});
