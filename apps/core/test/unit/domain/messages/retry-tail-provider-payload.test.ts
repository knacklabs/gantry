import { describe, expect, it } from 'vitest';

import { buildObserverDigestMessageView } from '@core/domain/observer-digest-view.js';
import { sanitizeRetryTailProviderPayload } from '@core/domain/messages/retry-tail-provider-payload.js';

function wellFormedView() {
  return buildObserverDigestMessageView({
    localDay: '2026-07-25',
    recipient: 'owner:happy',
    insights: [
      { id: 'i-1', title: 'First', summary: 'One', insightType: 'commitment' },
      { id: 'i-2', title: 'Second', summary: 'Two', insightType: 'commitment' },
    ],
  });
}

describe('sanitizeRetryTailProviderPayload observerDigestView passthrough', () => {
  it('carries a well-formed view through with insights + affordances intact', () => {
    const view = wellFormedView();
    const out = sanitizeRetryTailProviderPayload({ observerDigestView: view });

    const survived = out?.observerDigestView;
    expect(survived?.localDay).toBe('2026-07-25');
    expect(survived?.recipient).toBe('owner:happy');
    expect(survived?.insights.map((i) => i.insightId)).toEqual(['i-1', 'i-2']);
    for (const insight of survived!.insights) {
      expect(insight.affordances.map((a) => a.action)).toEqual([
        'resolve',
        'dismiss',
        'snooze',
        'less_like_this',
      ]);
      for (const affordance of insight.affordances) {
        expect(affordance.kind).toBe('observer_feedback');
        expect(affordance.insightId).toBe(insight.insightId);
        expect(affordance.localDay).toBe('2026-07-25');
      }
    }
  });

  it('strips unknown extra keys inside the view, insight, and affordance', () => {
    const view = wellFormedView();
    const out = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        junkTop: 'x',
        insights: [{ ...view.insights[0], junkInsight: 'y' }],
      },
    });

    const survived = out?.observerDigestView as Record<string, unknown>;
    expect(survived).toBeDefined();
    expect(survived.junkTop).toBeUndefined();
    const insight = (survived.insights as Record<string, unknown>[])[0];
    expect(insight.junkInsight).toBeUndefined();
    expect(insight.insightId).toBe('i-1');
  });

  it('drops an affordance with an unknown action', () => {
    const view = wellFormedView();
    const out = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [
          {
            ...view.insights[0],
            affordances: [
              ...view.insights[0].affordances,
              {
                kind: 'observer_feedback',
                label: 'Nuke',
                insightId: 'i-1',
                action: 'delete_everything',
                localDay: '2026-07-25',
              },
            ],
          },
        ],
      },
    });
    const actions = out?.observerDigestView?.insights[0].affordances.map(
      (a) => a.action,
    );
    expect(actions).toEqual(['resolve', 'dismiss', 'snooze', 'less_like_this']);
  });

  it('drops affordances whose insightId or localDay does not match their container', () => {
    const view = wellFormedView();
    const out = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [
          {
            ...view.insights[0],
            affordances: [
              // Foreign insightId: click would settle a DIFFERENT insight.
              {
                kind: 'observer_feedback',
                label: 'Resolve',
                insightId: 'i-2',
                action: 'resolve',
                localDay: '2026-07-25',
              },
              // Foreign localDay: click would settle a different digest day.
              {
                kind: 'observer_feedback',
                label: 'Dismiss',
                insightId: 'i-1',
                action: 'dismiss',
                localDay: '2026-07-26',
              },
              // Correctly bound: survives.
              {
                kind: 'observer_feedback',
                label: 'Snooze',
                insightId: 'i-1',
                action: 'snooze',
                localDay: '2026-07-25',
              },
            ],
          },
        ],
      },
    });
    const survived = out?.observerDigestView?.insights[0].affordances;
    expect(survived).toEqual([
      {
        kind: 'observer_feedback',
        label: 'Snooze',
        insightId: 'i-1',
        action: 'snooze',
        localDay: '2026-07-25',
      },
    ]);
  });

  it('rejects (does not trim-normalize) identity fields with surrounding whitespace', () => {
    const view = wellFormedView();

    // Insight insightId with whitespace -> insight dropped (not normalized+kept).
    const insightSpaced = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [
          { ...view.insights[0], insightId: ' i-1 ' },
          view.insights[1],
        ],
      },
    });
    expect(
      insightSpaced?.observerDigestView?.insights.map((i) => i.insightId),
    ).toEqual(['i-2']);

    // View localDay with whitespace -> whole view dropped.
    const viewSpaced = sanitizeRetryTailProviderPayload({
      observerDigestView: { ...view, localDay: ' 2026-07-25 ' },
    });
    expect(viewSpaced?.observerDigestView).toBeUndefined();

    // Over-limit ONLY because of surrounding whitespace -> still dropped
    // (length is measured on the RAW value, not the trimmed one).
    const paddedOverLimit = ' '.repeat(60) + 'day' + ' '.repeat(60); // >64 raw
    const dayPadded = sanitizeRetryTailProviderPayload({
      observerDigestView: { ...view, localDay: paddedOverLimit },
    });
    expect(dayPadded?.observerDigestView).toBeUndefined();
  });

  it('bounds the number of INSPECTED entries, not just accepted ones', () => {
    const view = wellFormedView();
    // 50 invalid entries (null) fill the inspection budget; a VALID insight sits
    // at index 50. If the loop bounded only ACCEPTED entries it would inspect all
    // 51 and keep the valid one; bounding INSPECTED entries stops at 50, so the
    // valid entry beyond the cap is never reached -> zero insights.
    const insights = [...Array(50).fill(null), view.insights[0]];
    const out = sanitizeRetryTailProviderPayload({
      observerDigestView: { ...view, insights },
    });
    expect(out?.observerDigestView?.insights).toEqual([]);

    // Same for affordances: 8 invalid then a valid one beyond the cap -> dropped.
    const affordances = [
      ...Array(8).fill(null),
      view.insights[0].affordances[0],
    ];
    const affOut = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [{ ...view.insights[0], affordances }],
      },
    });
    expect(affOut?.observerDigestView?.insights[0].affordances).toEqual([]);
  });

  it('rejects (does not truncate) oversized identity fields', () => {
    const view = wellFormedView();
    const bigId = 'x'.repeat(300); // > MAX_ID_LENGTH (256)
    const bigDay = 'd'.repeat(65); // > MAX_DIGEST_SHORT (64)

    // Oversized insight insightId -> that insight is dropped, sibling survives.
    const insightDropped = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [{ ...view.insights[0], insightId: bigId }, view.insights[1]],
      },
    });
    expect(
      insightDropped?.observerDigestView?.insights.map((i) => i.insightId),
    ).toEqual(['i-2']);

    // Oversized affordance insightId -> the owning insight (same oversized id)
    // drops entirely, proving the id was never truncated-and-kept.
    const affDropped = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [
          {
            ...view.insights[0],
            insightId: bigId,
            affordances: [
              {
                kind: 'observer_feedback',
                label: 'Resolve',
                insightId: bigId,
                action: 'resolve',
                localDay: '2026-07-25',
              },
            ],
          },
        ],
      },
    });
    expect(affDropped?.observerDigestView?.insights).toEqual([]);

    // Oversized affordance localDay -> that affordance dropped, insight kept.
    const dayDropped = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [
          {
            ...view.insights[0],
            affordances: [
              {
                kind: 'observer_feedback',
                label: 'Resolve',
                insightId: 'i-1',
                action: 'resolve',
                localDay: bigDay,
              },
            ],
          },
        ],
      },
    });
    expect(dayDropped?.observerDigestView?.insights[0].affordances).toEqual([]);

    // Oversized view localDay -> no view at all.
    const viewDropped = sanitizeRetryTailProviderPayload({
      observerDigestView: { ...view, localDay: bigDay },
    });
    expect(viewDropped?.observerDigestView).toBeUndefined();
  });

  it('drops the whole view when localDay is missing (fail safe to text-only)', () => {
    const view = wellFormedView();
    const { localDay: _drop, ...noDay } = view;
    const out = sanitizeRetryTailProviderPayload({ observerDigestView: noDay });
    expect(out?.observerDigestView).toBeUndefined();
  });

  it('drops an insight missing its insightId but keeps the valid siblings', () => {
    const view = wellFormedView();
    const out = sanitizeRetryTailProviderPayload({
      observerDigestView: {
        ...view,
        insights: [{ title: 'orphan', affordances: [] }, view.insights[1]],
      },
    });
    expect(out?.observerDigestView?.insights.map((i) => i.insightId)).toEqual([
      'i-2',
    ]);
  });

  it('bounds oversized fields and array counts', () => {
    const big = 'a'.repeat(5_000);
    const affordances = Array.from({ length: 40 }, () => ({
      kind: 'observer_feedback',
      label: 'Resolve',
      insightId: 'i-1',
      action: 'resolve',
      localDay: '2026-07-25',
    }));
    const insights = Array.from({ length: 200 }, (_unused, idx) => ({
      insightId: `i-${idx}`,
      title: big,
      summary: big,
      type: 'commitment',
      affordances,
    }));
    const out = sanitizeRetryTailProviderPayload({
      observerDigestView: { localDay: '2026-07-25', insights },
    });
    const survived = out!.observerDigestView!;
    expect(survived.insights.length).toBeLessThanOrEqual(50);
    expect(survived.insights[0].title!.length).toBeLessThanOrEqual(200);
    expect(survived.insights[0].summary!.length).toBeLessThanOrEqual(1_000);
    expect(survived.insights[0].affordances.length).toBeLessThanOrEqual(8);
  });

  it('ignores a non-object view entirely', () => {
    expect(
      sanitizeRetryTailProviderPayload({ observerDigestView: 'nope' }),
    ).toBeUndefined();
    expect(
      sanitizeRetryTailProviderPayload({ observerDigestView: [1, 2, 3] }),
    ).toBeUndefined();
  });
});

describe('sanitizeRetryTailProviderPayload jobPermissionCard passthrough', () => {
  const jobPermissionCard = {
    callbackKey: '0123456789abcdef01234567',
    revision: 3,
    operation: 'send' as const,
    actions: [
      {
        token: 'jp:0123456789abcdef01234567:request:grant:a',
        label: 'Allow',
      },
    ],
  };

  it('carries callbackKey and revision through intact', () => {
    const out = sanitizeRetryTailProviderPayload({ jobPermissionCard });

    expect(out?.jobPermissionCard).toEqual(jobPermissionCard);
    expect(
      sanitizeRetryTailProviderPayload({
        jobPermissionCard: { ...jobPermissionCard, revision: 10_115 },
      })?.jobPermissionCard?.revision,
    ).toBe(10_115);
  });

  it('keeps retire outcome, rows, and delivery state', () => {
    const retireCard = {
      ...jobPermissionCard,
      operation: 'retire' as const,
      providerMessageId: '42',
      retireOutcome: 'expired' as const,
      retiredRows: [{ label: 'Run Command: npm test' }],
      retireDelivery: {
        deleteFailedAt: '2026-08-28T11:59:00.000Z',
        receiptMessageId: '42',
      },
      actions: [],
    };
    const out = sanitizeRetryTailProviderPayload({
      jobPermissionCard: retireCard,
      jobPermissionCardRetireDelivery: {
        deletedAt: '2026-08-28T12:00:00.000Z',
      },
    });

    expect(out?.jobPermissionCard).toEqual(retireCard);
    expect(out?.jobPermissionCardRetireDelivery).toEqual({
      deletedAt: '2026-08-28T12:00:00.000Z',
    });
  });

  it('drops cards without a callbackKey or safe integer revision', () => {
    const { callbackKey: _callbackKey, ...withoutCallbackKey } =
      jobPermissionCard;
    expect(
      sanitizeRetryTailProviderPayload({
        jobPermissionCard: withoutCallbackKey,
      })?.jobPermissionCard,
    ).toBeUndefined();
    expect(
      sanitizeRetryTailProviderPayload({
        jobPermissionCard: { ...jobPermissionCard, revision: 3.5 },
      })?.jobPermissionCard,
    ).toBeUndefined();
    expect(
      sanitizeRetryTailProviderPayload({
        jobPermissionCard: { ...jobPermissionCard, revision: -1 },
      })?.jobPermissionCard,
    ).toBeUndefined();
  });
});
