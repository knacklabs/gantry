import { describe, expect, it, vi } from 'vitest';

import {
  handleObserverFeedbackAction,
  type ObserverFeedbackMessageActionDeps,
} from '@core/app/bootstrap/runtime-observer-feedback-message-action.js';
import type { ObserverActivationStatus } from '@core/config/settings/observer-activation.js';
import type { ObserverDigestMessageView } from '@core/domain/observer-digest-view.js';
import type {
  ObserverOwnerActionInsight,
  ProactiveInsight,
} from '@core/domain/ports/observer-insights.js';
import type { ObserverFeedbackMessageActionInput } from '@core/domain/types.js';

const APP_ID = 'default';
const OWNER = 'U-owner';
const OWNER_JID = 'sl:D-owner';
const OWNER_ACCOUNT = 'acct-1';
const LOCAL_DAY = '2026-07-27';

function baseAction(
  overrides: Partial<ObserverFeedbackMessageActionInput> = {},
): ObserverFeedbackMessageActionInput {
  return {
    kind: 'observer_feedback',
    conversationJid: OWNER_JID,
    providerAccountId: OWNER_ACCOUNT,
    userId: OWNER,
    insightId: 'ins-1',
    action: 'resolve',
    localDay: LOCAL_DAY,
    ...overrides,
  };
}

function ownerActivation(): ObserverActivationStatus {
  return {
    state: 'active',
    enabled: true,
    active: true,
    message: 'Observer is active.',
    owner: {
      recipient: OWNER,
      conversation: 'owner-dm',
      conversationJid: OWNER_JID,
      providerAccountId: OWNER_ACCOUNT,
      providerId: 'slack',
      externalConversationId: 'D-owner',
    },
  };
}

function insight(overrides: Partial<ProactiveInsight> = {}): ProactiveInsight {
  return {
    id: 'ins-1',
    appId: APP_ID,
    subject: 'observer:app',
    insightType: 'stale_fact',
    title: 'Title',
    summary: 'Summary',
    evidenceRefs: [],
    batchSnapshotAt: '2026-07-01T00:00:00.000Z',
    evidenceVersion: 1,
    canonicalSignature: 'sig',
    signatureEmbeddingRef: null,
    confidence: 0.9,
    priorityScore: 0.9,
    state: 'cooldown',
    cooldownUntil: null,
    resolvedAt: null,
    surfacedAt: '2026-07-01T09:00:00.000Z',
    recipient: OWNER,
    deliveryId: 'del-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
  };
}

function ownerInsight(
  overrides: Partial<ObserverOwnerActionInsight> = {},
): ObserverOwnerActionInsight {
  return {
    insight: insight(),
    conversationJid: OWNER_JID,
    providerAccountId: OWNER_ACCOUNT,
    threadId: null,
    ...overrides,
  };
}

function digestView(): ObserverDigestMessageView {
  return {
    localDay: '2026-07-01',
    recipient: OWNER,
    insights: [
      {
        insightId: 'ins-1',
        title: 'Title',
        summary: 'Summary',
        type: 'stale_fact',
        affordances: [
          {
            kind: 'observer_feedback',
            label: 'Resolve',
            insightId: 'ins-1',
            action: 'resolve',
            localDay: '2026-07-01',
          },
        ],
      },
      {
        insightId: 'ins-2',
        title: 'Other',
        summary: 'Other',
        type: 'commitment',
        affordances: [
          {
            kind: 'observer_feedback',
            label: 'Resolve',
            insightId: 'ins-2',
            action: 'resolve',
            localDay: '2026-07-01',
          },
        ],
      },
    ],
  };
}

function makeDeps(overrides: Partial<ObserverFeedbackMessageActionDeps> = {}): {
  deps: ObserverFeedbackMessageActionDeps;
  applyOwnerAction: ReturnType<typeof vi.fn>;
  resolveVerifiedOwner: ReturnType<typeof vi.fn>;
  findInsightForOwnerAction: ReturnType<typeof vi.fn>;
  loadReservationView: ReturnType<typeof vi.fn>;
  listOwnerActions: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const applyOwnerAction = vi.fn(async () => ({ outcome: 'applied' as const }));
  const resolveVerifiedOwner = vi.fn(async () => ownerActivation());
  const findInsightForOwnerAction = vi.fn(async () => ownerInsight());
  const loadReservationView = vi.fn(async () => digestView());
  // Default feedback truth: only the just-acted insight has a recorded action.
  const listOwnerActions = vi.fn(
    async () => new Map([['ins-1', 'resolve' as const]]),
  );
  const warn = vi.fn();
  return {
    applyOwnerAction,
    resolveVerifiedOwner,
    findInsightForOwnerAction,
    loadReservationView,
    listOwnerActions,
    warn,
    deps: {
      appId: APP_ID,
      nowIso: () => '2026-07-02T00:00:00.000Z',
      resolveVerifiedOwner,
      findInsightForOwnerAction: findInsightForOwnerAction as never,
      applyOwnerAction: applyOwnerAction as never,
      loadReservationView,
      listOwnerActions: listOwnerActions as never,
      warn,
      ...overrides,
    },
  };
}

describe('handleObserverFeedbackAction', () => {
  it('applies an owner action and rebuilds the digest view with the locked params', async () => {
    const { deps, applyOwnerAction, loadReservationView } = makeDeps();

    const outcome = await handleObserverFeedbackAction(deps, baseAction());

    expect(applyOwnerAction).toHaveBeenCalledWith({
      appId: APP_ID,
      recipient: OWNER,
      actorUserId: OWNER,
      insightId: 'ins-1',
      action: 'resolve',
      nowIso: '2026-07-02T00:00:00.000Z',
      snoozeMs: 30 * 24 * 60 * 60 * 1000,
      suppressMs: 60 * 24 * 60 * 60 * 1000,
      suppressThreshold: 2,
    });
    expect(loadReservationView).toHaveBeenCalledTimes(1);
    expect(loadReservationView).toHaveBeenCalledWith({
      recipient: OWNER,
      localDay: LOCAL_DAY,
    });
    expect(outcome.state).toBe('applied');
    expect(outcome.receipt).toBe('Insight resolved.');
    const view = outcome.observerDigestView!;
    // Acted insight: affordances cleared + marker; the other stays actionable.
    expect(view.insights[0]!.affordances).toEqual([]);
    expect(view.insights[0]!.stateMarker).toBe('✓ resolved');
    expect(view.insights[1]!.affordances).toHaveLength(1);
    expect(view.insights[1]!.stateMarker).toBeUndefined();
  });

  it('denies a missing authenticated user without mutating', async () => {
    const { deps, applyOwnerAction } = makeDeps();
    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ userId: '' as never }),
    );
    expect(outcome.state).toBe('invalid');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('denies a non-owner user without mutating', async () => {
    const { deps, applyOwnerAction } = makeDeps();
    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ userId: 'U-someone-else' }),
    );
    expect(outcome.state).toBe('denied');
    expect(outcome.receipt).toMatch(/only the digest owner/i);
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('denies a mismatched conversation route without mutating', async () => {
    const { deps, applyOwnerAction } = makeDeps();
    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ conversationJid: 'sl:D-other' }),
    );
    expect(outcome.state).toBe('denied');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('denies a mismatched provider account without mutating', async () => {
    const { deps, applyOwnerAction } = makeDeps();
    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ providerAccountId: 'acct-other' }),
    );
    expect(outcome.state).toBe('denied');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('denies when the owner route is not verified', async () => {
    const { deps, applyOwnerAction } = makeDeps({
      resolveVerifiedOwner: vi.fn(async () => ({
        state: 'configuration_required',
        enabled: true,
        active: false,
        reason: 'owner_recipient_not_verified',
        message: 'unverified',
      })) as never,
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('denied');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('treats an insight outside owner scope as invalid without mutating', async () => {
    const { deps, applyOwnerAction } = makeDeps({
      findInsightForOwnerAction: vi.fn(async () => null) as never,
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('invalid');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('treats an insight delivered on another route as invalid without mutating', async () => {
    const { deps, applyOwnerAction } = makeDeps({
      findInsightForOwnerAction: vi.fn(async () =>
        ownerInsight({ conversationJid: 'sl:D-other' }),
      ) as never,
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('invalid');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('maps a stale executor result to stale', async () => {
    const { deps } = makeDeps({
      applyOwnerAction: vi.fn(async () => ({
        outcome: 'stale' as const,
      })) as never,
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('stale');
  });

  it('maps an invalid executor result to invalid', async () => {
    const { deps } = makeDeps({
      applyOwnerAction: vi.fn(async () => ({
        outcome: 'invalid' as const,
      })) as never,
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('invalid');
  });

  it('maps a thrown lookup/DB error to invalid with no unhandled rejection', async () => {
    const { deps, applyOwnerAction } = makeDeps({
      findInsightForOwnerAction: vi.fn(async () => {
        throw new Error('db down');
      }) as never,
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('invalid');
    expect(applyOwnerAction).not.toHaveBeenCalled();
  });

  it('mentions the insight type on less_like_this', async () => {
    const { deps } = makeDeps();
    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ action: 'less_like_this' }),
    );
    expect(outcome.state).toBe('applied');
    expect(outcome.receipt).toMatch(/fewer stale fact/i);
  });

  it('rebuilds ALL prior owner actions, not just the just-acted insight', async () => {
    // Owner already resolved ins-1 and dismissed ins-2 (durable feedback truth);
    // ins-3 is untouched. Acting again must show BOTH settled + ins-3 actionable.
    const view: ObserverDigestMessageView = {
      localDay: '2026-07-01',
      recipient: OWNER,
      insights: [
        digestView().insights[0]!,
        digestView().insights[1]!,
        {
          insightId: 'ins-3',
          title: 'Third',
          summary: 'Third',
          type: 'open_question',
          affordances: [
            {
              kind: 'observer_feedback',
              label: 'Resolve',
              insightId: 'ins-3',
              action: 'resolve',
              localDay: '2026-07-01',
            },
          ],
        },
      ],
    };
    const { deps } = makeDeps({
      loadReservationView: vi.fn(async () => view),
      listOwnerActions: vi.fn(
        async () =>
          new Map([
            ['ins-1', 'resolve' as const],
            ['ins-2', 'dismiss' as const],
          ]),
      ) as never,
    });

    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ insightId: 'ins-2', action: 'dismiss' }),
    );

    const rebuilt = outcome.observerDigestView!;
    expect(rebuilt.insights[0]!.affordances).toEqual([]);
    expect(rebuilt.insights[0]!.stateMarker).toBe('✓ resolved');
    expect(rebuilt.insights[1]!.affordances).toEqual([]);
    expect(rebuilt.insights[1]!.stateMarker).toBe('✕ dismissed');
    expect(rebuilt.insights[2]!.affordances).toHaveLength(1);
    expect(rebuilt.insights[2]!.stateMarker).toBeUndefined();
  });

  it('loads the reservation for the callback local_day (the OLDER digest), never the newest', async () => {
    // Same insight rode two digests. Clicking the OLDER message's button must
    // load the OLDER reservation's view — keyed by the token's local_day.
    const OLD_DAY = '2026-07-01';
    const oldView: ObserverDigestMessageView = {
      localDay: OLD_DAY,
      recipient: OWNER,
      insights: [{ ...digestView().insights[0]!, title: 'OLD digest' }],
    };
    const loadReservationView = vi.fn(async ({ localDay }) =>
      localDay === OLD_DAY ? oldView : digestView(),
    );
    const { deps } = makeDeps({ loadReservationView });

    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ localDay: OLD_DAY }),
    );

    expect(loadReservationView).toHaveBeenCalledWith({
      recipient: OWNER,
      localDay: OLD_DAY,
    });
    expect(outcome.observerDigestView!.localDay).toBe(OLD_DAY);
    expect(outcome.observerDigestView!.insights[0]!.title).toBe('OLD digest');
  });

  it('resolves the correct digest after a timezone config change (local_day comes from the token)', async () => {
    // No surfacedAt/timezone recompute — the button carries its own local_day, so
    // a later tz change cannot mis-key the reservation lookup.
    const { deps, loadReservationView } = makeDeps();
    await handleObserverFeedbackAction(
      deps,
      baseAction({ localDay: LOCAL_DAY }),
    );
    expect(loadReservationView).toHaveBeenCalledWith({
      recipient: OWNER,
      localDay: LOCAL_DAY,
    });
  });

  it('still applies with a plain receipt when the view re-load fails', async () => {
    const { deps, warn } = makeDeps({
      loadReservationView: vi.fn(async () => null),
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('applied');
    expect(outcome.observerDigestView).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still applies when the view re-load throws', async () => {
    const { deps, warn } = makeDeps({
      loadReservationView: vi.fn(async () => {
        throw new Error('reservation gone');
      }),
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('applied');
    expect(outcome.observerDigestView).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('snooze receipt names the 30-day window', async () => {
    const { deps } = makeDeps();
    const outcome = await handleObserverFeedbackAction(
      deps,
      baseAction({ action: 'snooze' }),
    );
    expect(outcome.receipt).toBe('Insight snoozed for 30 days.');
  });
});
