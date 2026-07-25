import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ObserverDeliveryStatus } from '@core/config/settings/observer-activation.js';
import type {
  ObserverDigestReservation,
  ObserverInsightRepository,
  ProactiveInsight,
} from '@core/domain/ports/observer-insights.js';
import type { InsightFreshnessProbe } from '@core/brain/observer-evidence-freshness.js';

const hoisted = vi.hoisted(() => ({
  status: null as ObserverDeliveryStatus | null,
}));

vi.mock('@core/config/settings/observer-activation.js', () => ({
  resolveObserverDeliveryStatus: () => hoisted.status,
}));

import {
  runObserverDigest,
  type DigestDeliveryPort,
  type RunObserverDigestDeps,
} from '@core/brain/observer-digest.js';

const OWNER = {
  recipient: 'owner-1',
  conversation: 'owner-dm',
  conversationJid: 'sl:D999',
  providerAccountId: 'slack_default',
  providerId: 'slack',
  externalConversationId: 'D999',
};

function eligible(
  schedule: Partial<{
    timezone: string;
    sendAt: string;
    quietHours: { start: string; end: string };
    maxInsights: number;
  }> = {},
): ObserverDeliveryStatus {
  return {
    eligible: true,
    owner: OWNER,
    schedule: {
      timezone: schedule.timezone ?? 'UTC',
      sendAt: schedule.sendAt ?? '09:00',
      maxInsights: schedule.maxInsights ?? 5,
      ...(schedule.quietHours ? { quietHours: schedule.quietHours } : {}),
    },
  };
}

let counter = 0;
function makeInsight(
  overrides: Partial<ProactiveInsight> = {},
): ProactiveInsight {
  counter += 1;
  return {
    id: `ins-${counter}`,
    appId: 'default',
    subject: 'observer:app',
    insightType: 'commitment',
    title: `Insight ${counter}`,
    summary: `Summary ${counter}`,
    evidenceRefs: [
      {
        conversationId: 'sl:D999',
        messageId: `m-${counter}`,
        ts: '2026-07-25T00:00:00.000Z',
        providerAccountId: 'slack_default',
        conversationJid: 'sl:D999',
      },
    ],
    batchSnapshotAt: '2026-07-25T00:00:00.000Z',
    evidenceVersion: 1,
    canonicalSignature: `sig-${counter}`,
    signatureEmbeddingRef: null,
    confidence: 0.9,
    priorityScore: 1,
    state: 'claimed',
    cooldownUntil: null,
    resolvedAt: null,
    surfacedAt: null,
    recipient: 'owner-1',
    deliveryId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function reservationFrom(input: {
  id: string;
  conversationJid: string;
  providerAccountId: string;
  localDay: string;
}): ObserverDigestReservation {
  return {
    id: input.id,
    appId: 'default',
    recipient: 'owner-1',
    localDay: input.localDay,
    state: 'reserved',
    timezone: 'UTC',
    conversationJid: input.conversationJid,
    providerAccountId: input.providerAccountId,
    threadId: null,
    renderedDigest: 'digest',
    contentHash: 'hash',
    outboundDeliveryId: null,
    reservedAt: '2026-07-25T12:00:00.000Z',
    sentAt: null,
    settledAt: null,
    createdAt: '2026-07-25T12:00:00.000Z',
  };
}

function makeRepo(
  overrides: Partial<ObserverInsightRepository> = {},
): ObserverInsightRepository {
  const repo = {
    recoverStaleDigestClaims: vi.fn(async () => []),
    claimPendingForDigest: vi.fn(async () => [] as ProactiveInsight[]),
    transitionState: vi.fn(async () => null),
    reserveDigest: vi.fn(async (input: { id: string }) => ({
      reservation: reservationFrom({
        id: input.id,
        conversationJid: OWNER.conversationJid,
        providerAccountId: OWNER.providerAccountId,
        localDay: '2026-07-25',
      }),
      created: true,
    })),
    settleDigest: vi.fn(async () => null),
    ...overrides,
  };
  return repo as unknown as ObserverInsightRepository;
}

function makeProbe(
  isStale: (i: ProactiveInsight) => boolean,
): InsightFreshnessProbe {
  return { isStale: vi.fn(async (i: ProactiveInsight) => isStale(i)) };
}

function makeDeps(
  status: ObserverDeliveryStatus,
  repo: ObserverInsightRepository,
  probe: InsightFreshnessProbe,
  deliveryPort: DigestDeliveryPort,
): RunObserverDigestDeps {
  hoisted.status = status;
  return {
    settings: {} as RunObserverDigestDeps['settings'],
    repository: repo,
    freshnessProbe: probe,
    deliveryPort,
    idFactory: () => 'res-fixed',
  };
}

const NOW = '2026-07-25T12:00:00.000Z'; // 12:00 UTC

describe('runObserverDigest gating', () => {
  beforeEach(() => {
    counter = 0;
    hoisted.status = null;
  });

  it('skips when delivery is not eligible', async () => {
    const repo = makeRepo();
    const probe = makeProbe(() => false);
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      { eligible: false, reason: 'delivery_disabled', message: 'off' },
      repo,
      probe,
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'delivery_disabled' });
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
    expect(repo.reserveDigest).not.toHaveBeenCalled();
    expect(port.deliver).not.toHaveBeenCalled();
  });

  it('skips before the owner-local send window', async () => {
    const repo = makeRepo();
    const port = { deliver: vi.fn(async () => {}) };
    // 12:00 UTC but sendAt 20:00 => before window.
    const deps = makeDeps(
      eligible({ sendAt: '20:00' }),
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'before_send_window' });
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
    expect(repo.reserveDigest).not.toHaveBeenCalled();
  });

  it('skips inside quiet hours (upper half of a midnight-crossing window)', async () => {
    const repo = makeRepo();
    const port = { deliver: vi.fn(async () => {}) };
    // 23:00 UTC, quiet 22:00-07:00 => quiet; past sendAt 09:00.
    const deps = makeDeps(
      eligible({
        sendAt: '09:00',
        quietHours: { start: '22:00', end: '07:00' },
      }),
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T23:00:00.000Z',
      deps,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'quiet_hours' });
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
  });

  it('skips inside quiet hours (lower half after midnight)', async () => {
    const repo = makeRepo();
    const port = { deliver: vi.fn(async () => {}) };
    // 03:00 UTC, sendAt 00:00 (past window), quiet 22:00-07:00 => quiet.
    const deps = makeDeps(
      eligible({
        sendAt: '00:00',
        quietHours: { start: '22:00', end: '07:00' },
      }),
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T03:00:00.000Z',
      deps,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'quiet_hours' });
  });

  it('proceeds when past send window and outside quiet hours', async () => {
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [makeInsight()]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    // 12:00 UTC, sendAt 09:00, quiet 22:00-07:00 => not quiet.
    const deps = makeDeps(
      eligible({
        sendAt: '09:00',
        quietHours: { start: '22:00', end: '07:00' },
      }),
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(result.status).toBe('reserved');
    expect(repo.reserveDigest).toHaveBeenCalledTimes(1);
  });
});

describe('runObserverDigest pipeline', () => {
  beforeEach(() => {
    counter = 0;
    hoisted.status = null;
  });

  it('reserves with the bare owner route and hands off to the delivery port', async () => {
    const insight = makeInsight();
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [insight]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      eligible(),
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(repo.recoverStaleDigestClaims).toHaveBeenCalledTimes(1);
    const reserveArg = (repo.reserveDigest as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(reserveArg).toMatchObject({
      id: 'res-fixed',
      appId: 'default',
      recipient: 'owner-1',
      timezone: 'UTC',
      conversationJid: 'sl:D999',
      providerAccountId: 'slack_default',
      threadId: null,
      localDay: '2026-07-25',
    });
    // Bare jid, never a qualified route key.
    expect(reserveArg.conversationJid).not.toContain('agent:');
    expect(reserveArg.memberships).toEqual([
      { insightId: insight.id, claimedAt: NOW, position: 0 },
    ]);
    // deliveryPort receives the reservation; settleDigest is T4's job.
    expect(port.deliver).toHaveBeenCalledTimes(1);
    expect(port.deliver.mock.calls[0][0]).toMatchObject({ id: 'res-fixed' });
    expect(repo.settleDigest).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'reserved',
      reservationId: 'res-fixed',
      localDay: '2026-07-25',
      selected: 1,
    });
  });

  it('computes local_day from the IANA timezone, not the UTC day', async () => {
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [makeInsight()]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    // 20:00 UTC on the 25th is 01:30 on the 26th in Kolkata (UTC+5:30).
    const deps = makeDeps(
      eligible({ timezone: 'Asia/Kolkata', sendAt: '00:00' }),
      repo,
      makeProbe(() => false),
      port,
    );

    await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T20:00:00.000Z',
      deps,
    });

    const reserveArg = (repo.reserveDigest as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(reserveArg.localDay).toBe('2026-07-26');
  });

  it('drops and releases a stale insight, excluding it from the digest', async () => {
    const fresh = makeInsight({ id: 'fresh' });
    const stale = makeInsight({ id: 'stale' });
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [fresh, stale]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      eligible(),
      repo,
      makeProbe((i) => i.id === 'stale'),
      port,
    );

    await runObserverDigest({ appId: 'default', nowIso: NOW, deps });

    expect(repo.transitionState).toHaveBeenCalledWith({
      id: 'stale',
      from: 'claimed',
      to: 'pending',
      nowIso: NOW,
    });
    const reserveArg = (repo.reserveDigest as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(reserveArg.memberships).toEqual([
      { insightId: 'fresh', claimedAt: NOW, position: 0 },
    ]);
  });

  it('drops insights below the value floor', async () => {
    const good = makeInsight({ id: 'good', confidence: 0.9 });
    const lowConf = makeInsight({ id: 'low', confidence: 0.5 });
    const noEvidence = makeInsight({ id: 'noev', evidenceRefs: [] });
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [good, lowConf, noEvidence]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      eligible(),
      repo,
      makeProbe(() => false),
      port,
    );

    await runObserverDigest({ appId: 'default', nowIso: NOW, deps });

    const reserveArg = (repo.reserveDigest as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(
      reserveArg.memberships.map((m: { insightId: string }) => m.insightId),
    ).toEqual(['good']);
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'low', to: 'pending' }),
    );
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'noev', to: 'pending' }),
    );
  });

  it('selects top-N by priority then stable order and releases the overflow', async () => {
    const a = makeInsight({
      id: 'a',
      priorityScore: 5,
      createdAt: '2026-07-25T01:00:00.000Z',
    });
    const b = makeInsight({
      id: 'b',
      priorityScore: 9,
      createdAt: '2026-07-25T02:00:00.000Z',
    });
    const c = makeInsight({
      id: 'c',
      priorityScore: 5,
      createdAt: '2026-07-25T00:30:00.000Z',
    });
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [a, b, c]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      eligible({ maxInsights: 2 }),
      repo,
      makeProbe(() => false),
      port,
    );

    await runObserverDigest({ appId: 'default', nowIso: NOW, deps });

    const reserveArg = (repo.reserveDigest as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    // b (priority 9) first; then tie 5/5 broken by earlier createdAt => c.
    expect(reserveArg.memberships).toEqual([
      { insightId: 'b', claimedAt: NOW, position: 0 },
      { insightId: 'c', claimedAt: NOW, position: 1 },
    ]);
    expect(reserveArg.renderedDigest).toContain('1. Insight');
    // Overflow 'a' released back to pending.
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', to: 'pending' }),
    );
  });

  it('makes no reservation and releases all claims when nothing survives', async () => {
    const one = makeInsight({ id: 'one' });
    const two = makeInsight({ id: 'two' });
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [one, two]),
    });
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      eligible(),
      repo,
      makeProbe(() => true),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'no_qualifying_insights',
    });
    expect(repo.reserveDigest).not.toHaveBeenCalled();
    expect(port.deliver).not.toHaveBeenCalled();
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'one', to: 'pending' }),
    );
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'two', to: 'pending' }),
    );
    expect(repo.settleDigest).not.toHaveBeenCalled();
  });

  it('treats an existing reservation as already-done without a duplicate send', async () => {
    const insight = makeInsight({ id: 'dup' });
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [insight]),
      reserveDigest: vi.fn(async (input: { id: string }) => ({
        reservation: reservationFrom({
          id: input.id,
          conversationJid: OWNER.conversationJid,
          providerAccountId: OWNER.providerAccountId,
          localDay: '2026-07-25',
        }),
        created: false,
      })),
    });
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      eligible(),
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'already_reserved' });
    // No duplicate send; the selected claim is released back to pending.
    expect(port.deliver).not.toHaveBeenCalled();
    expect(repo.transitionState).toHaveBeenCalledWith({
      id: 'dup',
      from: 'claimed',
      to: 'pending',
      nowIso: NOW,
    });
    expect(repo.settleDigest).not.toHaveBeenCalled();
  });
});
