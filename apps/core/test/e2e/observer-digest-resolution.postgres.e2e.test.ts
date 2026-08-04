import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ObserverInsightCreate } from '@core/domain/ports/observer-insights.js';
import type {
  ObserverActivationStatus,
  ObserverDeliveryStatus,
} from '@core/config/settings/observer-activation.js';
import type { DigestSendGateway } from '@core/brain/observer-digest.js';
import type { ObserverDigestMessageView } from '@core/domain/observer-digest-view.js';

import { createChannelMessageActionRouter } from '@core/app/bootstrap/channel-message-action-router.js';
import {
  handleObserverFeedbackAction,
  type ObserverFeedbackMessageActionDeps,
} from '@core/app/bootstrap/runtime-observer-feedback-message-action.js';
import {
  telegramObserverDigestMessage,
  TELEGRAM_OBSERVER_CALLBACK_PATTERN,
  OBSERVER_FEEDBACK_BY_CODE,
} from '@core/channels/telegram/observer-digest-message.js';
import { teamsObserverDigestCard } from '@core/channels/teams-cards.js';
import { handleTeamsMessageAction } from '@core/channels/teams-message-actions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// runObserverDigest reads the owner route from resolveObserverDeliveryStatus; the
// digest integration suite mocks it the same way, so the real claim→reserve→settle
// path runs against Postgres while the route comes from the test.
const hoisted = vi.hoisted(() => ({
  status: null as ObserverDeliveryStatus | null,
}));

vi.mock('@core/config/settings/observer-activation.js', () => ({
  resolveObserverDeliveryStatus: () => hoisted.status,
  // Unused here (the executor's own resolveVerifiedOwner is injected below), but
  // the module is mocked wholesale so keep the export present.
  resolveVerifiedObserverActivationStatus: async () => ({ state: 'inactive' }),
}));

const { runObserverDigest, createOutboundDigestDeliveryPort } =
  await import('@core/brain/observer-digest.js');

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'observer-resolution-e2e';
const NOW = '2026-07-25T12:00:00.000Z'; // inside a 00:00 UTC send window
const ACTED_AT = '2026-07-25T13:00:00.000Z';
const LOCAL_DAY = '2026-07-25';
const ACTIONS = ['resolve', 'dismiss', 'snooze', 'less_like_this'] as const;

function insight(
  id: string,
  recipient: string,
  priorityScore: number,
): ObserverInsightCreate {
  return {
    id,
    appId: APP_ID,
    subject: 'observer:app',
    insightType: 'commitment',
    title: `Insight ${id}`,
    summary: `Summary ${id}`,
    evidenceRefs: [{ conversationId: 'observer:app', messageId: id, ts: NOW }],
    batchSnapshotAt: NOW,
    evidenceVersion: 1,
    canonicalSignature: `signature:${id}`,
    confidence: 0.9,
    priorityScore,
    recipient,
    nowIso: NOW,
  };
}

function eligibleStatus(owner: {
  recipient: string;
  conversationJid: string;
  providerAccountId: string;
  providerId: string;
}): ObserverDeliveryStatus {
  return {
    eligible: true,
    owner: {
      recipient: owner.recipient,
      conversation: 'owner-dm',
      conversationJid: owner.conversationJid,
      providerAccountId: owner.providerAccountId,
      providerId: owner.providerId,
      externalConversationId: 'ext',
    },
    schedule: { timezone: 'UTC', sendAt: '00:00', maxInsights: 5 },
  };
}

function ownerActivation(owner: {
  recipient: string;
  conversationJid: string;
  providerAccountId: string;
  providerId: string;
}): ObserverActivationStatus {
  return {
    state: 'active',
    enabled: true,
    active: true,
    message: 'Observer is active.',
    owner: {
      recipient: owner.recipient,
      conversation: 'owner-dm',
      conversationJid: owner.conversationJid,
      providerAccountId: owner.providerAccountId,
      providerId: owner.providerId,
      externalConversationId: 'ext',
    },
  };
}

// Each insight's Teams buttons live in an ActionSet INSIDE its Container.
function insightActionSets(
  card: ReturnType<typeof teamsObserverDigestCard>,
): Array<Array<{ data: unknown }>> {
  return (card.body as Array<Record<string, unknown>>)
    .filter((block) => block.type === 'Container')
    .map((container) => {
      const items = (container.items ?? []) as Array<Record<string, unknown>>;
      const actionSet = items.find((item) => item.type === 'ActionSet');
      return (actionSet?.actions ?? []) as Array<{ data: unknown }>;
    });
}

maybeDescribe('observer digest resolution round-trip (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_resolution',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Observer resolution e2e',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  // Deliver a real digest (claim → reserve → settle) on the given owner route and
  // return its persisted, affordance-bearing view.
  async function deliverDigest(owner: {
    recipient: string;
    conversationJid: string;
    providerAccountId: string;
    providerId: string;
    insightIds: [string, string];
  }): Promise<ObserverDigestMessageView> {
    const repo = runtime.repositories.observerInsights;
    await repo.create(insight(owner.insightIds[0], owner.recipient, 0.9));
    await repo.create(insight(owner.insightIds[1], owner.recipient, 0.8));

    hoisted.status = eligibleStatus(owner);
    const gateway: DigestSendGateway = {
      enqueue: vi.fn(async () => ({
        outboundDeliveryId: `out-${owner.recipient}`,
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
        freshnessProbe: { isStale: async () => false },
        deliveryPort,
        idFactory: () => `delivery-${owner.recipient}`,
      },
    });
    expect(result).toMatchObject({ status: 'reserved', selected: 2 });

    const reservation = await repo.findDigestReservation({
      appId: APP_ID,
      recipient: owner.recipient,
      localDay: LOCAL_DAY,
    });
    const view = reservation?.renderedView;
    expect(view?.insights.map((i) => i.insightId)).toEqual(owner.insightIds);
    return view!;
  }

  // The real owner-only executor, wired to the Postgres repo, behind the real router.
  function routerFor(owner: {
    recipient: string;
    conversationJid: string;
    providerAccountId: string;
    providerId: string;
  }): ReturnType<typeof createChannelMessageActionRouter> {
    const repo = runtime.repositories.observerInsights;
    const deps: ObserverFeedbackMessageActionDeps = {
      appId: APP_ID,
      nowIso: () => ACTED_AT,
      resolveVerifiedOwner: async () => ownerActivation(owner),
      findInsightForOwnerAction: (input) =>
        repo.findInsightForOwnerAction(input),
      applyOwnerAction: (input) => repo.applyOwnerAction(input),
      loadReservation: async ({ recipient, localDay }) => {
        const reservation = await repo.findDigestReservation({
          appId: APP_ID,
          recipient,
          localDay,
        });
        return reservation
          ? { deliveryId: reservation.id, view: reservation.renderedView }
          : null;
      },
      listOwnerActions: (input) => repo.listOwnerActionsForInsights(input),
      warn: () => undefined,
    };
    const router = createChannelMessageActionRouter();
    router.setObserverFeedbackHandler((action) =>
      handleObserverFeedbackAction(deps, action),
    );
    return router;
  }

  async function insightsById(): Promise<Map<string, { state: string }>> {
    const rows = await runtime.repositories.observerInsights.list({
      appId: APP_ID,
      subject: 'observer:app',
      limit: 50,
    });
    return new Map(rows.map((r) => [r.id, { state: r.state }]));
  }

  async function feedbackCount(insightId: string): Promise<number> {
    const { rows } = await runtime.service.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM "${runtime.schemaName}".observer_insight_feedback
       WHERE insight_id = $1`,
      [insightId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  it('Telegram: render → callback_data decode → router → owner auth → applyOwnerAction → DB → rebuilt keyboard', async () => {
    const owner = {
      recipient: 'owner:tg1',
      conversationJid: 'tg:9001',
      providerAccountId: 'pa-tg',
      providerId: 'telegram',
    };
    const view = await deliverDigest({
      ...owner,
      insightIds: ['tg1-a', 'tg1-b'],
    });
    const router = routerFor(owner);

    // Render the native keyboard, then decode the acted button through the REAL
    // Telegram codec — exactly what the inbound callback handler does.
    const keyboard =
      telegramObserverDigestMessage(view).reply_markup.inline_keyboard;
    const resolveButton = keyboard[0][ACTIONS.indexOf('resolve')];
    const match = TELEGRAM_OBSERVER_CALLBACK_PATTERN.exec(
      resolveButton.callback_data,
    );
    expect(match).not.toBeNull();
    const decoded = {
      action: OBSERVER_FEEDBACK_BY_CODE[match![1]],
      insightId: match![2],
      localDay: match![3],
    };
    expect(decoded).toMatchObject({ action: 'resolve', insightId: 'tg1-a' });

    const outcome = await router.handle({
      kind: 'observer_feedback',
      conversationJid: owner.conversationJid,
      providerAccountId: owner.providerAccountId,
      userId: owner.recipient,
      insightId: decoded.insightId,
      action: decoded.action,
      localDay: decoded.localDay,
    });

    // Outcome: applied, and the rebuilt view drops ONLY tg-a's buttons.
    expect(outcome).toMatchObject({
      state: 'applied',
      receipt: 'Insight resolved.',
    });
    const rebuilt = outcome!.observerDigestView!;
    expect(rebuilt.insights[0]).toMatchObject({
      insightId: 'tg1-a',
      affordances: [],
      stateMarker: '✓ resolved',
    });
    expect(rebuilt.insights[1].insightId).toBe('tg1-b');
    expect(rebuilt.insights[1].affordances).toHaveLength(4);

    // Re-render: the acted insight's keyboard row is gone; the other stays live.
    const rebuiltRows =
      telegramObserverDigestMessage(rebuilt).reply_markup.inline_keyboard;
    expect(rebuiltRows).toHaveLength(1);

    // Durable DB state actually changed.
    const states = await insightsById();
    expect(states.get('tg1-a')?.state).toBe('resolved');
    expect(states.get('tg1-b')?.state).toBe('cooldown');
    expect(await feedbackCount('tg1-a')).toBe(1);
    expect(await feedbackCount('tg1-b')).toBe(0);
  });

  it('Teams: full card handler → decode → router → applyOwnerAction → DB → rebuilt card (acted loses ActionSet, other keeps it)', async () => {
    const owner = {
      recipient: 'owner:teams',
      conversationJid: 'teams:ownerdm',
      providerAccountId: 'pa-teams',
      providerId: 'teams',
    };
    const view = await deliverDigest({
      ...owner,
      insightIds: ['tm-a', 'tm-b'],
    });
    const router = routerFor(owner);

    const card = teamsObserverDigestCard(view, {
      targetJid: owner.conversationJid,
    });
    // Click "Dismiss" on the SECOND insight (tm-b).
    const actionData =
      insightActionSets(card)[1][ACTIONS.indexOf('dismiss')].data;

    let rebuiltCard: ReturnType<typeof teamsObserverDigestCard> | null = null;
    const sendDenied = vi.fn(async () => undefined);
    const handled = await handleTeamsMessageAction({
      message: { id: 'm-teams', value: actionData } as never,
      jid: owner.conversationJid,
      userId: owner.recipient,
      providerAccountId: owner.providerAccountId,
      onMessageAction: (action) => router.handle(action),
      sendDenied,
      updateReviewCard: async ({ card: next }) => {
        rebuiltCard = next as ReturnType<typeof teamsObserverDigestCard>;
      },
    });

    expect(handled).toBe(true);
    expect(sendDenied).not.toHaveBeenCalled();
    expect(rebuiltCard).not.toBeNull();

    // Rebuilt card: tm-b lost its ActionSet + shows a marker; tm-a keeps 4 actions.
    const sets = insightActionSets(rebuiltCard!);
    expect(sets[0]).toHaveLength(4); // tm-a still actionable
    expect(sets[1]).toHaveLength(0); // tm-b settled

    // Durable DB state actually changed (dismiss → dropped).
    const states = await insightsById();
    expect(states.get('tm-b')?.state).toBe('dropped');
    expect(states.get('tm-a')?.state).toBe('cooldown');
    expect(await feedbackCount('tm-b')).toBe(1);
    expect(await feedbackCount('tm-a')).toBe(0);
  });

  it('rebuilds from ALL durable owner actions: an earlier settled insight stays marked when a second one is acted', async () => {
    // Self-contained: seed a fresh digest, resolve tg3-a, THEN dismiss tg3-b and
    // confirm the rebuild re-marks BOTH (the view is rebuilt from every durable
    // feedback row, not just the just-clicked insight).
    const owner = {
      recipient: 'owner:tg3',
      conversationJid: 'tg:9003',
      providerAccountId: 'pa-tg',
      providerId: 'telegram',
    };
    await deliverDigest({ ...owner, insightIds: ['tg3-a', 'tg3-b'] });
    const router = routerFor(owner);

    const click = (insightId: string, action: 'resolve' | 'dismiss') =>
      router.handle({
        kind: 'observer_feedback',
        conversationJid: owner.conversationJid,
        providerAccountId: owner.providerAccountId,
        userId: owner.recipient,
        insightId,
        action,
        localDay: LOCAL_DAY,
      });

    await click('tg3-a', 'resolve');
    const outcome = await click('tg3-b', 'dismiss');
    expect(outcome).toMatchObject({ state: 'applied' });
    const rebuilt = outcome!.observerDigestView!;
    expect(rebuilt.insights[0]).toMatchObject({
      insightId: 'tg3-a',
      stateMarker: '✓ resolved',
      affordances: [],
    });
    expect(rebuilt.insights[1]).toMatchObject({
      insightId: 'tg3-b',
      stateMarker: '✕ dismissed',
      affordances: [],
    });
  });

  it('denies a non-owner clicker without mutating the durable state', async () => {
    const owner = {
      recipient: 'owner:deny',
      conversationJid: 'teams:denydm',
      providerAccountId: 'pa-deny',
      providerId: 'teams',
    };
    await deliverDigest({ ...owner, insightIds: ['dn-a', 'dn-b'] });
    const router = routerFor(owner);
    const outcome = await router.handle({
      kind: 'observer_feedback',
      conversationJid: owner.conversationJid,
      providerAccountId: owner.providerAccountId,
      userId: 'intruder', // not the owner recipient
      insightId: 'dn-a',
      action: 'resolve',
      localDay: LOCAL_DAY,
    });
    expect(outcome).toMatchObject({ state: 'denied' });
    // dn-a is still open, no feedback row written.
    const states = await insightsById();
    expect(states.get('dn-a')?.state).toBe('cooldown');
    expect(await feedbackCount('dn-a')).toBe(0);
  });
});
