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
  buildDigestPreview,
  digestPrefetchLimit,
  createOutboundDigestDeliveryPort,
  digestOutboundIdempotencyKey,
  OBSERVER_DIGEST_COOLDOWN_MS,
  type DigestDeliveryPort,
  type DigestSendGateway,
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

function reservationFrom(
  overrides: Partial<ObserverDigestReservation> = {},
): ObserverDigestReservation {
  return {
    id: 'res-fixed',
    appId: 'default',
    recipient: 'owner-1',
    localDay: '2026-07-25',
    state: 'reserved',
    timezone: 'UTC',
    conversationJid: OWNER.conversationJid,
    providerAccountId: OWNER.providerAccountId,
    threadId: null,
    renderedDigest: 'digest',
    renderedView: null,
    contentHash: 'hash',
    outboundDeliveryId: null,
    reservedAt: '2026-07-25T12:00:00.000Z',
    sentAt: null,
    settledAt: null,
    createdAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<ObserverInsightRepository> = {},
): ObserverInsightRepository {
  const repo = {
    findDigestReservation: vi.fn(async () => null),
    findUnsettledDigestReservations: vi.fn(
      async () => [] as ObserverDigestReservation[],
    ),
    recoverStaleDigestClaims: vi.fn(async () => []),
    claimPendingForDigest: vi.fn(async () => [] as ProactiveInsight[]),
    transitionState: vi.fn(async () => null),
    reserveDigest: vi.fn(async (input: { id: string }) => ({
      reservation: reservationFrom({ id: input.id }),
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
const CLAIMED_AT = '2026-07-25T12:00:00.000Z'; // makeInsight default updatedAt

describe('runObserverDigest gating', () => {
  beforeEach(() => {
    counter = 0;
    hoisted.status = null;
  });

  it('skips when delivery is not eligible', async () => {
    const repo = makeRepo();
    const port = { deliver: vi.fn(async () => {}) };
    const deps = makeDeps(
      { eligible: false, reason: 'delivery_disabled', message: 'off' },
      repo,
      makeProbe(() => false),
      port,
    );

    const result = await runObserverDigest({
      appId: 'default',
      nowIso: NOW,
      deps,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'delivery_disabled' });
    expect(repo.findDigestReservation).not.toHaveBeenCalled();
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
  });

  it('skips before the effective send window', async () => {
    const repo = makeRepo();
    const port = { deliver: vi.fn(async () => {}) };
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
  });

  it('skips inside quiet hours (upper half of a midnight-crossing window)', async () => {
    const repo = makeRepo();
    const port = { deliver: vi.fn(async () => {}) };
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
  });

  it('defers a send whose configured time falls inside quiet hours to quiet-end', async () => {
    // sendAt 23:00 is inside quiet 22:00-07:00 => effective earliest is 07:00.
    const schedule = eligible({
      sendAt: '23:00',
      quietHours: { start: '22:00', end: '07:00' },
    });

    // 06:00 local: before effective 07:00 window => before_send_window.
    let repo = makeRepo();
    let port = { deliver: vi.fn(async () => {}) };
    let result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T06:00:00.000Z',
      deps: makeDeps(
        schedule,
        repo,
        makeProbe(() => false),
        port,
      ),
    });
    expect(result).toEqual({ status: 'skipped', reason: 'before_send_window' });

    // 07:30 local: past quiet-end, not quiet => delivers.
    repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [makeInsight()]),
    });
    port = { deliver: vi.fn(async () => {}) };
    result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T07:30:00.000Z',
      deps: makeDeps(
        schedule,
        repo,
        makeProbe(() => false),
        port,
      ),
    });
    expect(result.status).toBe('reserved');

    // 23:30 local: past effective window but currently quiet => skip.
    repo = makeRepo();
    port = { deliver: vi.fn(async () => {}) };
    result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T23:30:00.000Z',
      deps: makeDeps(
        schedule,
        repo,
        makeProbe(() => false),
        port,
      ),
    });
    expect(result).toEqual({ status: 'skipped', reason: 'quiet_hours' });
  });

  it('delivers a normal send time outside quiet hours at send time', async () => {
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [makeInsight()]),
    });
    const port = { deliver: vi.fn(async () => {}) };
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

describe('runObserverDigest existing-reservation short-circuit', () => {
  beforeEach(() => {
    counter = 0;
    hoisted.status = null;
  });

  it('skips (already delivered) when today is already settled', async () => {
    const repo = makeRepo({
      findDigestReservation: vi.fn(async () =>
        reservationFrom({ state: 'settled' }),
      ),
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

    expect(result).toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(port.deliver).not.toHaveBeenCalled();
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
  });

  it('retries delivery of an existing unsettled reservation without re-claiming', async () => {
    const existing = reservationFrom({ id: 'res-existing', state: 'reserved' });
    const repo = makeRepo({
      findUnsettledDigestReservations: vi.fn(async () => [existing]),
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

    expect(result).toEqual({
      status: 'retried',
      reservationId: 'res-existing',
      localDay: '2026-07-25',
    });
    expect(port.deliver).toHaveBeenCalledWith(existing);
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
    expect(repo.reserveDigest).not.toHaveBeenCalled();
    // Today's dedicated read isn't needed once a backlog reservation is found.
    expect(repo.findDigestReservation).not.toHaveBeenCalled();
  });

  it('re-drives a reservation from a PRIOR local_day (cross-midnight orphan)', async () => {
    // Reservation created yesterday, still reserved; clock is now the next day.
    const yesterday = reservationFrom({
      id: 'res-yesterday',
      state: 'reserved',
      localDay: '2026-07-24',
    });
    const repo = makeRepo({
      findUnsettledDigestReservations: vi.fn(async () => [yesterday]),
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
      nowIso: NOW, // 2026-07-25
      deps,
    });

    expect(result).toEqual({
      status: 'retried',
      reservationId: 'res-yesterday',
      localDay: '2026-07-25',
    });
    expect(port.deliver).toHaveBeenCalledWith(yesterday);
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();
  });

  it('defers a redrive during quiet hours (no send), then delivers after quiet-end', async () => {
    const existing = reservationFrom({ id: 'res-defer', state: 'reserved' });
    const schedule = eligible({
      sendAt: '09:00',
      quietHours: { start: '22:00', end: '07:00' },
    });

    // 23:00 UTC is inside quiet hours -> defer, no deliver.
    let repo = makeRepo({
      findUnsettledDigestReservations: vi.fn(async () => [existing]),
    });
    let port = { deliver: vi.fn(async () => {}) };
    let result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T23:00:00.000Z',
      deps: makeDeps(
        schedule,
        repo,
        makeProbe(() => false),
        port,
      ),
    });
    expect(result).toEqual({
      status: 'skipped',
      reason: 'deferred_quiet_hours',
    });
    expect(port.deliver).not.toHaveBeenCalled();
    expect(repo.claimPendingForDigest).not.toHaveBeenCalled();

    // 07:30 UTC is past quiet-end -> redrive delivers.
    repo = makeRepo({
      findUnsettledDigestReservations: vi.fn(async () => [existing]),
    });
    port = { deliver: vi.fn(async () => {}) };
    result = await runObserverDigest({
      appId: 'default',
      nowIso: '2026-07-25T07:30:00.000Z',
      deps: makeDeps(
        schedule,
        repo,
        makeProbe(() => false),
        port,
      ),
    });
    expect(result.status).toBe('retried');
    expect(port.deliver).toHaveBeenCalledWith(existing);
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
    expect(reserveArg.conversationJid).not.toContain('agent:');
    expect(reserveArg.memberships).toEqual([
      { insightId: insight.id, claimedAt: CLAIMED_AT, position: 0 },
    ]);
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
    expect(
      (repo.findDigestReservation as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .localDay,
    ).toBe('2026-07-26');
  });

  it('drops a stale insight to the terminal state, excluding it from the digest', async () => {
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

    // Stale => dropped (terminal), NOT pending.
    expect(repo.transitionState).toHaveBeenCalledWith({
      id: 'stale',
      from: 'claimed',
      to: 'dropped',
      claimedAt: CLAIMED_AT,
      nowIso: NOW,
    });
    const reserveArg = (repo.reserveDigest as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(reserveArg.memberships).toEqual([
      { insightId: 'fresh', claimedAt: CLAIMED_AT, position: 0 },
    ]);
  });

  it('drops below-floor insights to terminal', async () => {
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
      expect.objectContaining({ id: 'low', to: 'dropped' }),
    );
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'noev', to: 'dropped' }),
    );
  });

  it('selects top-N by priority then stable order; releases fresh overflow to pending', async () => {
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
    expect(reserveArg.memberships).toEqual([
      { insightId: 'b', claimedAt: CLAIMED_AT, position: 0 },
      { insightId: 'c', claimedAt: CLAIMED_AT, position: 1 },
    ]);
    // Overflow 'a' is fresh + eligible => released back to pending (NOT dropped).
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'a',
        to: 'pending',
        claimedAt: CLAIMED_AT,
      }),
    );
  });

  it('makes no reservation and drops all claims when nothing survives freshness', async () => {
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
      expect.objectContaining({ id: 'one', to: 'dropped' }),
    );
    expect(repo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'two', to: 'dropped' }),
    );
    expect(repo.settleDigest).not.toHaveBeenCalled();
  });

  it('releases claims and skips on a reservation race (created=false)', async () => {
    const insight = makeInsight({ id: 'dup' });
    const repo = makeRepo({
      claimPendingForDigest: vi.fn(async () => [insight]),
      reserveDigest: vi.fn(async (input: { id: string }) => ({
        reservation: reservationFrom({ id: input.id }),
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
    expect(port.deliver).not.toHaveBeenCalled();
    expect(repo.transitionState).toHaveBeenCalledWith({
      id: 'dup',
      from: 'claimed',
      to: 'pending',
      claimedAt: CLAIMED_AT,
      nowIso: NOW,
    });
    expect(repo.settleDigest).not.toHaveBeenCalled();
  });
});

describe('createOutboundDigestDeliveryPort', () => {
  const reservation = reservationFrom({ id: 'res-1', renderedDigest: 'hello' });
  const SEND_NOW = '2026-07-25T12:00:00.000Z';

  it('settles ONLY after a durable send', async () => {
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'outbound-1',
        durablySent: true,
      })),
    };
    const settleDigest = vi.fn(async () => null);
    const port = createOutboundDigestDeliveryPort({
      gateway,
      repository: { settleDigest },
      now: () => SEND_NOW,
    });

    await port.deliver(reservation);

    expect(gateway.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        conversationJid: 'sl:D999',
        providerAccountId: 'slack_default',
        threadId: null,
        idempotencyKey: digestOutboundIdempotencyKey(reservation),
        text: 'hello',
      }),
    );
    expect(settleDigest).toHaveBeenCalledWith({
      deliveryId: 'res-1',
      outboundDeliveryId: 'outbound-1',
      cooldownUntil: new Date(
        Date.parse(SEND_NOW) + OBSERVER_DIGEST_COOLDOWN_MS,
      ).toISOString(),
      nowIso: SEND_NOW,
    });
  });

  it('does NOT settle when the send is not yet durable (leaves reserved for retry)', async () => {
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'outbound-1',
        durablySent: false,
      })),
    };
    const settleDigest = vi.fn(async () => null);
    const port = createOutboundDigestDeliveryPort({
      gateway,
      repository: { settleDigest },
      now: () => SEND_NOW,
    });

    await port.deliver(reservation);

    expect(gateway.enqueue).toHaveBeenCalledTimes(1);
    expect(settleDigest).not.toHaveBeenCalled();
  });

  it('is a no-op for an already-settled reservation', async () => {
    const gateway: DigestSendGateway = { enqueue: vi.fn() };
    const settleDigest = vi.fn(async () => null);
    const port = createOutboundDigestDeliveryPort({
      gateway,
      repository: { settleDigest },
      now: () => SEND_NOW,
    });

    await port.deliver(reservationFrom({ id: 'res-1', state: 'settled' }));

    expect(gateway.enqueue).not.toHaveBeenCalled();
    expect(settleDigest).not.toHaveBeenCalled();
  });

  it('uses a deterministic idempotency key per app/recipient/day', () => {
    expect(
      digestOutboundIdempotencyKey({
        appId: 'default',
        recipient: 'owner-1',
        localDay: '2026-07-25',
      }),
    ).toBe('observer-digest:default:owner-1:2026-07-25');
  });
});

describe('buildDigestPreview (pure, write-free)', () => {
  const NOW = '2026-07-25T12:00:00.000Z';
  const alwaysFresh: InsightFreshnessProbe = { isStale: async () => false };

  it('applies freshness + floor + stable top-N and renders, without a repository', async () => {
    const high = makeInsight({ id: 'hi', priorityScore: 3 });
    const mid = makeInsight({ id: 'mid', priorityScore: 2 });
    const low = makeInsight({ id: 'lo', priorityScore: 1 });
    const probe = { isStale: vi.fn(async () => false) };

    const preview = await buildDigestPreview({
      nowIso: NOW,
      timezone: 'UTC',
      maxInsights: 2,
      candidates: [mid, low, high],
      freshnessProbe: probe,
    });

    expect(preview.localDay).toBe('2026-07-25');
    expect(preview.selected.map((i) => i.id)).toEqual(['hi', 'mid']);
    expect(preview.skippedReason).toBeNull();
    expect(preview.renderedDigest).toContain('Insight');
    // Only the freshness read happened; selection is otherwise pure.
    expect(probe.isStale).toHaveBeenCalledTimes(3);
  });

  it('drops stale and below-floor candidates and reports no_qualifying_insights', async () => {
    const stale = makeInsight({ id: 'stale' });
    const lowConf = makeInsight({ id: 'low', confidence: 0.3 });
    const probe = {
      isStale: vi.fn(async (i: ProactiveInsight) => i.id === 'stale'),
    };

    const preview = await buildDigestPreview({
      nowIso: NOW,
      timezone: 'UTC',
      maxInsights: 5,
      candidates: [stale, lowConf],
      freshnessProbe: probe,
    });

    expect(preview.selected).toEqual([]);
    expect(preview.renderedDigest).toBeNull();
    expect(preview.skippedReason).toBe('no_qualifying_insights');
  });

  it('an empty pool preview never sends and never throws', async () => {
    const preview = await buildDigestPreview({
      nowIso: NOW,
      timezone: 'UTC',
      maxInsights: 5,
      candidates: [],
      freshnessProbe: alwaysFresh,
    });
    expect(preview.skippedReason).toBe('no_qualifying_insights');
  });

  it('digestPrefetchLimit floors at 30 and scales with maxInsights', () => {
    expect(digestPrefetchLimit(5)).toBe(30);
    expect(digestPrefetchLimit(20)).toBe(60);
  });
});
