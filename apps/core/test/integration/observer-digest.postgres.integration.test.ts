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
});
