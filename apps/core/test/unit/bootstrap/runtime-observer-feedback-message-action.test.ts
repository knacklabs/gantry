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
  loadDigestView: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const applyOwnerAction = vi.fn(async () => ({ outcome: 'applied' as const }));
  const resolveVerifiedOwner = vi.fn(async () => ownerActivation());
  const findInsightForOwnerAction = vi.fn(async () => ownerInsight());
  const loadDigestView = vi.fn(async () => digestView());
  const warn = vi.fn();
  return {
    applyOwnerAction,
    resolveVerifiedOwner,
    findInsightForOwnerAction,
    loadDigestView,
    warn,
    deps: {
      appId: APP_ID,
      nowIso: () => '2026-07-02T00:00:00.000Z',
      resolveVerifiedOwner,
      findInsightForOwnerAction: findInsightForOwnerAction as never,
      applyOwnerAction: applyOwnerAction as never,
      loadDigestView,
      warn,
      ...overrides,
    },
  };
}

describe('handleObserverFeedbackAction', () => {
  it('applies an owner action and rebuilds the digest view with the locked params', async () => {
    const { deps, applyOwnerAction, loadDigestView } = makeDeps();

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
    expect(loadDigestView).toHaveBeenCalledTimes(1);
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

  it('still applies with a plain receipt when the view re-load fails', async () => {
    const { deps, warn } = makeDeps({
      loadDigestView: vi.fn(async () => null),
    });
    const outcome = await handleObserverFeedbackAction(deps, baseAction());
    expect(outcome.state).toBe('applied');
    expect(outcome.observerDigestView).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still applies when the view re-load throws', async () => {
    const { deps, warn } = makeDeps({
      loadDigestView: vi.fn(async () => {
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
