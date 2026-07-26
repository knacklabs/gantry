import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ObserverInsightCreate } from '@core/domain/ports/observer-insights.js';
import type { ObserverDeliveryStatus } from '@core/config/settings/observer-activation.js';
import type { DigestSendGateway } from '@core/brain/observer-digest.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const hoisted = vi.hoisted(() => ({
  status: null as ObserverDeliveryStatus | null,
}));

vi.mock('@core/config/settings/observer-activation.js', () => ({
  resolveObserverDeliveryStatus: () => hoisted.status,
}));

const {
  runObserverDigest,
  createOutboundDigestDeliveryPort,
  digestOutboundIdempotencyKey,
} = await import('@core/brain/observer-digest.js');

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'observer-digest-app';
const NOW = '2026-07-25T12:00:00.000Z'; // 12:00 UTC, inside a 00:00 send window

function eligibleStatus(recipient: string): ObserverDeliveryStatus {
  return {
    eligible: true,
    owner: {
      recipient,
      conversation: 'owner-dm',
      conversationJid: 'sl:D999',
      providerAccountId: 'slack_default',
      providerId: 'slack',
      externalConversationId: 'D999',
    },
    schedule: { timezone: 'UTC', sendAt: '00:00', maxInsights: 5 },
  };
}

function insight(
  id: string,
  recipient: string,
  overrides: Partial<ObserverInsightCreate> = {},
): ObserverInsightCreate {
  return {
    id,
    appId: APP_ID,
    subject: 'observer:app',
    insightType: 'commitment',
    title: `Insight ${id}`,
    summary: `Summary ${id}`,
    evidenceRefs: [
      {
        conversationId: 'sl:D999',
        messageId: id,
        ts: '2026-07-25T07:54:00.000Z',
        providerAccountId: 'slack_default',
        conversationJid: 'sl:D999',
      },
    ],
    batchSnapshotAt: '2026-07-25T07:55:00.000Z',
    evidenceVersion: 1,
    canonicalSignature: `signature:${id}`,
    confidence: 0.9,
    priorityScore: 0.9,
    recipient,
    nowIso: '2026-07-25T08:00:00.000Z',
    ...overrides,
  };
}

const alwaysFresh = { isStale: async () => false };

maybeDescribe('observer digest orchestration (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_digest',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Observer digest test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('reserve -> deliver(durably sent) -> settle moves members to cooldown', async () => {
    const repo = runtime.repositories.observerInsights;
    const recipient = 'owner:happy';
    await repo.create(insight('ok-1', recipient, { priorityScore: 0.9 }));
    await repo.create(insight('ok-2', recipient, { priorityScore: 0.8 }));

    hoisted.status = eligibleStatus(recipient);
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'outbound-happy',
        durablySent: true,
      })),
    };
    const deliveryPort = createOutboundDigestDeliveryPort({
      gateway,
      repository: repo,
      now: () => NOW,
    });

    const result = await runObserverDigest({
      appId: APP_ID,
      nowIso: NOW,
      deps: {
        settings: {} as never,
        repository: repo,
        freshnessProbe: alwaysFresh,
        deliveryPort,
        idFactory: () => 'delivery-happy',
      },
    });

    expect(result).toMatchObject({ status: 'reserved', selected: 2 });
    expect(gateway.enqueue).toHaveBeenCalledTimes(1);

    const reservation = await repo.findDigestReservation({
      appId: APP_ID,
      recipient,
      localDay: '2026-07-25',
    });
    expect(reservation).toMatchObject({
      state: 'settled',
      outboundDeliveryId: 'outbound-happy',
    });

    const members = await repo.list({
      appId: APP_ID,
      subject: 'observer:app',
      limit: 10,
    });
    const byId = new Map(members.map((m) => [m.id, m]));
    expect(byId.get('ok-1')).toMatchObject({
      state: 'cooldown',
      deliveryId: 'delivery-happy',
    });
    expect(byId.get('ok-2')).toMatchObject({ state: 'cooldown' });
  });

  it('persists the digest view so affordances survive an enqueue -> recovery round-trip', async () => {
    const repo = runtime.repositories.observerInsights;
    const recipient = 'owner:view';
    await repo.create(insight('view-1', recipient, { priorityScore: 0.9 }));
    await repo.create(insight('view-2', recipient, { priorityScore: 0.8 }));

    hoisted.status = eligibleStatus(recipient);
    // Send not yet durable -> the reservation stays 'reserved' (the recovery
    // backlog the next tick re-drives).
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'outbound-view',
        durablySent: false,
      })),
    };
    const deliveryPort = createOutboundDigestDeliveryPort({
      gateway,
      repository: repo,
      now: () => NOW,
    });

    await runObserverDigest({
      appId: APP_ID,
      nowIso: NOW,
      deps: {
        settings: {} as never,
        repository: repo,
        freshnessProbe: alwaysFresh,
        deliveryPort,
        idFactory: () => 'delivery-view',
      },
    });

    // The view is carried on the enqueue call (Task 4 renders native buttons).
    const enqueued = (gateway.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(enqueued.observerDigestView?.insights).toHaveLength(2);

    // ...and it SURVIVES the recovery round-trip: re-read from Postgres via the
    // digest recovery loop (findUnsettled) with the affordances intact. This is
    // the gap being closed — today only the rendered TEXT survives.
    const [recovered] = await repo.findUnsettledDigestReservations({
      appId: APP_ID,
      recipient,
    });
    const view = recovered?.renderedView;
    expect(view?.localDay).toBe('2026-07-25');
    expect(view?.recipient).toBe(recipient);
    expect(view?.insights.map((entry) => entry.insightId)).toEqual([
      'view-1',
      'view-2',
    ]);
    for (const entry of view!.insights) {
      expect(entry.affordances.map((a) => a.action)).toEqual([
        'resolve',
        'dismiss',
        'snooze',
        'less_like_this',
      ]);
      for (const affordance of entry.affordances) {
        expect(affordance.kind).toBe('observer_feedback');
        expect(affordance.insightId).toBe(entry.insightId);
      }
    }
  });

  it('deliver failure leaves the reservation unsettled and the next run retries it (idempotent key, no duplicate)', async () => {
    const repo = runtime.repositories.observerInsights;
    const recipient = 'owner:retry';
    await repo.create(insight('rt-1', recipient));

    hoisted.status = eligibleStatus(recipient);
    let durablySent = false;
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'outbound-retry',
        durablySent,
      })),
    };
    const deliveryPort = createOutboundDigestDeliveryPort({
      gateway,
      repository: repo,
      now: () => NOW,
    });
    const deps = {
      settings: {} as never,
      repository: repo,
      freshnessProbe: alwaysFresh,
      deliveryPort,
      idFactory: () => 'delivery-retry',
    };

    // First run: send is not yet durable -> reserved but unsettled, member claimed.
    const first = await runObserverDigest({ appId: APP_ID, nowIso: NOW, deps });
    expect(first).toMatchObject({ status: 'reserved' });
    let reservation = await repo.findDigestReservation({
      appId: APP_ID,
      recipient,
      localDay: '2026-07-25',
    });
    expect(reservation?.state).toBe('reserved');
    let member = (
      await repo.list({ appId: APP_ID, subject: 'observer:app', limit: 50 })
    ).find((m) => m.id === 'rt-1');
    expect(member?.state).toBe('claimed');

    // Second run same day: send now durable -> retried the SAME reservation,
    // no new claim, settle applies, member cools down.
    durablySent = true;
    const second = await runObserverDigest({
      appId: APP_ID,
      nowIso: NOW,
      deps,
    });
    expect(second).toMatchObject({
      status: 'retried',
      reservationId: 'delivery-retry',
    });

    reservation = await repo.findDigestReservation({
      appId: APP_ID,
      recipient,
      localDay: '2026-07-25',
    });
    expect(reservation).toMatchObject({
      state: 'settled',
      outboundDeliveryId: 'outbound-retry',
    });
    member = (
      await repo.list({ appId: APP_ID, subject: 'observer:app', limit: 50 })
    ).find((m) => m.id === 'rt-1');
    expect(member?.state).toBe('cooldown');

    // Idempotent enqueue: both runs targeted the identical per-day key.
    const keys = (gateway.enqueue as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].idempotencyKey,
    );
    expect(keys).toEqual([
      digestOutboundIdempotencyKey({
        appId: APP_ID,
        recipient,
        localDay: '2026-07-25',
      }),
      digestOutboundIdempotencyKey({
        appId: APP_ID,
        recipient,
        localDay: '2026-07-25',
      }),
    ]);
  });

  it('finds and settles a reservation stranded on a PRIOR local_day (cross-midnight orphan)', async () => {
    const repo = runtime.repositories.observerInsights;
    const recipient = 'owner:orphan';
    const claimedAt = '2026-07-24T23:59:00.000Z';
    await repo.create(insight('orph-1', recipient));
    const [claimed] = await repo.claimPendingForDigest({
      appId: APP_ID,
      recipient,
      limit: 10,
      nowIso: claimedAt,
    });
    // A reservation dated YESTERDAY, left unsettled (enqueue never confirmed).
    await repo.reserveDigest({
      id: 'delivery-orphan',
      appId: APP_ID,
      recipient,
      localDay: '2026-07-24',
      timezone: 'UTC',
      conversationJid: 'sl:D999',
      providerAccountId: 'slack_default',
      renderedDigest: 'Yesterday digest',
      contentHash: 'hash-orphan',
      memberships: [
        { insightId: 'orph-1', claimedAt: claimed!.updatedAt, position: 0 },
      ],
      nowIso: '2026-07-24T23:59:30.000Z',
    });

    hoisted.status = eligibleStatus(recipient);
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'outbound-orphan',
        durablySent: true,
      })),
    };
    const deliveryPort = createOutboundDigestDeliveryPort({
      gateway,
      repository: repo,
      now: () => NOW,
    });

    // Clock is now the NEXT day; today has no reservation, but the orphan must
    // still be found + settled.
    const result = await runObserverDigest({
      appId: APP_ID,
      nowIso: NOW, // 2026-07-25
      deps: {
        settings: {} as never,
        repository: repo,
        freshnessProbe: alwaysFresh,
        deliveryPort,
        idFactory: () => 'unused',
      },
    });

    expect(result).toMatchObject({
      status: 'retried',
      reservationId: 'delivery-orphan',
    });
    const reservation = await repo.findDigestReservation({
      appId: APP_ID,
      recipient,
      localDay: '2026-07-24',
    });
    expect(reservation).toMatchObject({
      state: 'settled',
      outboundDeliveryId: 'outbound-orphan',
    });
    const member = (
      await repo.list({ appId: APP_ID, subject: 'observer:app', limit: 50 })
    ).find((m) => m.id === 'orph-1');
    expect(member?.state).toBe('cooldown');
  });

  it('defers a redrive during quiet hours: performs NO enqueue', async () => {
    const repo = runtime.repositories.observerInsights;
    const recipient = 'owner:quiet-redrive';
    await repo.create(insight('qr-1', recipient));
    const [claimed] = await repo.claimPendingForDigest({
      appId: APP_ID,
      recipient,
      limit: 10,
      nowIso: '2026-07-25T00:00:00.000Z',
    });
    await repo.reserveDigest({
      id: 'delivery-quiet',
      appId: APP_ID,
      recipient,
      localDay: '2026-07-25',
      timezone: 'UTC',
      conversationJid: 'sl:D999',
      providerAccountId: 'slack_default',
      renderedDigest: 'Quiet digest',
      contentHash: 'hash-quiet',
      memberships: [
        { insightId: 'qr-1', claimedAt: claimed!.updatedAt, position: 0 },
      ],
      nowIso: '2026-07-25T00:01:00.000Z',
    });

    hoisted.status = {
      ...eligibleStatus(recipient),
      schedule: {
        timezone: 'UTC',
        sendAt: '09:00',
        maxInsights: 5,
        quietHours: { start: '22:00', end: '07:00' },
      },
    };
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: 'x',
        durablySent: true,
      })),
    };
    const deliveryPort = createOutboundDigestDeliveryPort({
      gateway,
      repository: repo,
      now: () => NOW,
    });

    // 23:00 UTC is inside quiet hours -> defer, no enqueue, still reserved.
    const result = await runObserverDigest({
      appId: APP_ID,
      nowIso: '2026-07-25T23:00:00.000Z',
      deps: {
        settings: {} as never,
        repository: repo,
        freshnessProbe: alwaysFresh,
        deliveryPort,
        idFactory: () => 'unused',
      },
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'deferred_quiet_hours',
    });
    expect(gateway.enqueue).not.toHaveBeenCalled();
    const reservation = await repo.findDigestReservation({
      appId: APP_ID,
      recipient,
      localDay: '2026-07-25',
    });
    expect(reservation?.state).toBe('reserved');
  });
});
