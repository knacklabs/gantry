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
      }
    }

    expect(view.insights[0]).toMatchObject({
      title: 'A title',
      summary: 'A summary',
      type: 'commitment',
    });
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
