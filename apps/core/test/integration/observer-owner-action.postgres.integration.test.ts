import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ObserverInsightCreate,
  ObserverInsightRepository,
} from '@core/domain/ports/observer-insights.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'observer-owner-action-app';
const SUBJECT = 'conversation:sl:C900' as const;
const RECIPIENT = 'owner:user-1';
const ACTOR = 'owner:user-1';
const NOW = '2026-07-22T08:00:00.000Z';
const COOLDOWN = '2026-07-29T08:00:00.000Z'; // NOW + 7d
const DAY_MS = 86_400_000;
const SNOOZE_MS = 30 * DAY_MS;
const SUPPRESS_MS = 60 * DAY_MS;
const THRESHOLD = 2;

function insight(
  id: string,
  overrides: Partial<ObserverInsightCreate> = {},
): ObserverInsightCreate {
  return {
    id,
    appId: APP_ID,
    subject: SUBJECT,
    insightType: 'commitment',
    title: `Insight ${id}`,
    summary: `Summary ${id}`,
    evidenceRefs: [{ conversationId: SUBJECT, messageId: id, ts: NOW }],
    batchSnapshotAt: NOW,
    evidenceVersion: 1,
    canonicalSignature: `signature:${id}`,
    confidence: 0.8,
    priorityScore: 0.5,
    recipient: RECIPIENT,
    nowIso: NOW,
    ...overrides,
  };
}

// Deliver a set of pending insights all the way into `cooldown` via the real
// digest path (claim -> reserve -> settle), so they carry a delivery route.
async function deliverToCooldown(
  repo: ObserverInsightRepository,
  reservationId: string,
  localDay: string,
): Promise<void> {
  const claimed = await repo.claimPendingForDigest({
    appId: APP_ID,
    recipient: RECIPIENT,
    limit: 50,
    nowIso: NOW,
  });
  const reserve = await repo.reserveDigest({
    id: reservationId,
    appId: APP_ID,
    recipient: RECIPIENT,
    localDay,
    timezone: 'UTC',
    conversationJid: 'sl:C900',
    providerAccountId: 'pa-slack-1',
    threadId: 'thread-9',
    renderedDigest: 'digest',
    contentHash: `hash-${reservationId}`,
    memberships: claimed.map((ins, index) => ({
      insightId: ins.id,
      claimedAt: ins.updatedAt,
      position: index,
    })),
    nowIso: NOW,
  });
  await repo.settleDigest({
    deliveryId: reserve.reservation.id,
    outboundDeliveryId: `out-${reservationId}`,
    cooldownUntil: COOLDOWN,
    nowIso: NOW,
  });
}

maybeDescribe('observer owner action Postgres persistence', () => {
  let runtime: PostgresIntegrationRuntime;
  let repo: ObserverInsightRepository;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_owner_action',
    });
    repo = runtime.repositories.observerInsights;
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Observer owner action test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const id of [
      'res',
      'dis',
      'snz',
      'snz2',
      'sr',
      'lk1',
      'lk2',
      'lk3',
      'lk4',
    ]) {
      await repo.create(
        insight(id, {
          insightType: id.startsWith('lk') ? 'repetition' : 'commitment',
        }),
      );
    }
    await deliverToCooldown(repo, 'delivery-1', '2026-07-22');
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  async function suppression(insightType: string): Promise<{
    negative_count: number;
    suppressed_until: string | null;
  } | null> {
    const { rows } = await runtime.service.pool.query<{
      negative_count: number;
      suppressed_until: string | null;
    }>(
      `SELECT negative_count, suppressed_until
       FROM "${runtime.schemaName}".observer_insight_type_suppressions
       WHERE app_id = $1 AND recipient = $2 AND insight_type = $3`,
      [APP_ID, RECIPIENT, insightType],
    );
    return rows[0] ?? null;
  }

  async function feedbackCount(insightId: string): Promise<number> {
    const { rows } = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::int AS count
       FROM "${runtime.schemaName}".observer_insight_feedback
       WHERE insight_id = $1`,
      [insightId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  const apply = (insightId: string, action: string) =>
    repo.applyOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      actorUserId: ACTOR,
      insightId,
      action: action as never,
      nowIso: NOW,
      snoozeMs: SNOOZE_MS,
      suppressMs: SUPPRESS_MS,
      suppressThreshold: THRESHOLD,
    });

  it('findInsightForOwnerAction returns the delivery route, or null outside (app,recipient)', async () => {
    const found = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightId: 'snz',
    });
    expect(found).toMatchObject({
      insight: { id: 'snz', state: 'cooldown' },
      conversationJid: 'sl:C900',
      providerAccountId: 'pa-slack-1',
      threadId: 'thread-9',
    });
    expect(
      await repo.findInsightForOwnerAction({
        appId: APP_ID,
        recipient: 'owner:someone-else',
        insightId: 'snz',
      }),
    ).toBeNull();
  });

  it('resolve moves cooldown -> resolved; same click replays idempotently; a different action is stale', async () => {
    expect(await apply('res', 'resolve')).toEqual({ outcome: 'applied' });
    const found = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightId: 'res',
    });
    expect(found?.insight).toMatchObject({
      state: 'resolved',
      resolvedAt: NOW,
    });
    // Same click (idempotency key present): no-op replay, not stale.
    expect(await apply('res', 'resolve')).toEqual({
      outcome: 'applied',
      already: true,
    });
    // A DIFFERENT action on the now-terminal insight (no matching key) is stale.
    expect(await apply('res', 'dismiss')).toEqual({ outcome: 'stale' });
  });

  it('dismiss moves cooldown -> dropped', async () => {
    expect(await apply('dis', 'dismiss')).toEqual({ outcome: 'applied' });
    const found = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightId: 'dis',
    });
    expect(found?.insight.state).toBe('dropped');
  });

  it('snooze extends cooldownUntil, never shortens, and is idempotent', async () => {
    expect(await apply('snz', 'snooze')).toEqual({ outcome: 'applied' });
    const extended = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightId: 'snz',
    });
    // NOW + 30d > original COOLDOWN (NOW + 7d).
    expect(extended?.insight.cooldownUntil).toBe('2026-08-21T08:00:00.000Z');
    expect(extended?.insight.state).toBe('cooldown');

    // Replay (same insight+actor+action) is a no-op: no further extension.
    expect(await apply('snz', 'snooze')).toEqual({
      outcome: 'applied',
      already: true,
    });
    const replayed = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightId: 'snz',
    });
    expect(replayed?.insight.cooldownUntil).toBe('2026-08-21T08:00:00.000Z');

    // A short snooze on a fresh insight must not shorten its existing cooldown.
    expect(
      await repo.applyOwnerAction({
        appId: APP_ID,
        recipient: RECIPIENT,
        actorUserId: ACTOR,
        insightId: 'snz2',
        action: 'snooze',
        nowIso: NOW,
        snoozeMs: DAY_MS, // NOW + 1d < COOLDOWN
        suppressMs: SUPPRESS_MS,
        suppressThreshold: THRESHOLD,
      }),
    ).toEqual({ outcome: 'applied' });
    const unshortened = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightId: 'snz2',
    });
    expect(unshortened?.insight.cooldownUntil).toBe(COOLDOWN);
  });

  it('less_like_this drops the insight, counts the type, and time-boxes suppression at the threshold', async () => {
    // First negative: dropped, count 1, not yet suppressed.
    expect(await apply('lk1', 'less_like_this')).toEqual({
      outcome: 'applied',
      suppressedType: false,
    });
    expect(
      (
        await repo.findInsightForOwnerAction({
          appId: APP_ID,
          recipient: RECIPIENT,
          insightId: 'lk1',
        })
      )?.insight.state,
    ).toBe('dropped');
    expect(await suppression('repetition')).toMatchObject({
      negative_count: 1,
      suppressed_until: null,
    });

    // Replay of lk1: idempotent, does NOT re-count and does NOT re-drop.
    expect(await apply('lk1', 'less_like_this')).toEqual({
      outcome: 'applied',
      already: true,
    });
    expect(await feedbackCount('lk1')).toBe(1);
    expect((await suppression('repetition'))?.negative_count).toBe(1);

    // Second distinct insight, same type: count 2 >= threshold -> suppressed.
    expect(await apply('lk2', 'less_like_this')).toEqual({
      outcome: 'applied',
      suppressedType: true,
    });
    const supp = await suppression('repetition');
    expect(supp?.negative_count).toBe(2);
    expect(supp?.suppressed_until).not.toBeNull();
    // NOW + 60d.
    expect(new Date(supp!.suppressed_until!).toISOString()).toBe(
      '2026-09-20T08:00:00.000Z',
    );
  });

  it('terminal precedence: replaying a non-terminal action after a settling action is stale', async () => {
    expect(await apply('sr', 'snooze')).toEqual({ outcome: 'applied' });
    expect(await apply('sr', 'resolve')).toEqual({ outcome: 'applied' });
    // sr is now resolved. A delayed replay of the ORIGINAL snooze must NOT ack
    // — the insight moved on.
    expect(await apply('sr', 'snooze')).toEqual({ outcome: 'stale' });
    // The action consistent with the terminal state still replays idempotently.
    expect(await apply('sr', 'resolve')).toEqual({
      outcome: 'applied',
      already: true,
    });
  });

  it('out-of-order negatives only extend the suppression window, never shorten it', async () => {
    // Precondition (from the less_like_this test): repetition is suppressed
    // until 2026-09-20 with count 2.
    const before = await suppression('repetition');
    expect(before?.negative_count).toBe(2);
    expect(new Date(before!.suppressed_until!).toISOString()).toBe(
      '2026-09-20T08:00:00.000Z',
    );

    // A LATER feedback carrying an EARLIER nowIso (shorter candidate window)
    // must not shorten suppressed_until or rewind last_feedback_at.
    expect(
      await repo.applyOwnerAction({
        appId: APP_ID,
        recipient: RECIPIENT,
        actorUserId: ACTOR,
        insightId: 'lk3',
        action: 'less_like_this',
        nowIso: '2026-07-20T08:00:00.000Z', // earlier than the current window's basis
        snoozeMs: SNOOZE_MS,
        suppressMs: SUPPRESS_MS,
        suppressThreshold: THRESHOLD,
      }),
    ).toMatchObject({ outcome: 'applied' });
    const afterEarly = await suppression('repetition');
    expect(afterEarly?.negative_count).toBe(3);
    // Unchanged — GREATEST kept the later window.
    expect(new Date(afterEarly!.suppressed_until!).toISOString()).toBe(
      '2026-09-20T08:00:00.000Z',
    );

    // A later nowIso with a longer window extends suppressed_until.
    const LK4_NOW = '2026-07-25T08:00:00.000Z';
    const LK4_SUPPRESS = 90 * DAY_MS;
    expect(
      await repo.applyOwnerAction({
        appId: APP_ID,
        recipient: RECIPIENT,
        actorUserId: ACTOR,
        insightId: 'lk4',
        action: 'less_like_this',
        nowIso: LK4_NOW,
        snoozeMs: SNOOZE_MS,
        suppressMs: LK4_SUPPRESS,
        suppressThreshold: THRESHOLD,
      }),
    ).toMatchObject({ outcome: 'applied' });
    const afterLate = await suppression('repetition');
    expect(afterLate?.negative_count).toBe(4);
    expect(new Date(afterLate!.suppressed_until!).toISOString()).toBe(
      new Date(Date.parse(LK4_NOW) + LK4_SUPPRESS).toISOString(),
    );
  });

  it('an insight outside (app,recipient) is invalid', async () => {
    expect(
      await repo.applyOwnerAction({
        appId: APP_ID,
        recipient: 'owner:someone-else',
        actorUserId: ACTOR,
        insightId: 'snz',
        action: 'resolve',
        nowIso: NOW,
        snoozeMs: SNOOZE_MS,
        suppressMs: SUPPRESS_MS,
        suppressThreshold: THRESHOLD,
      }),
    ).toEqual({ outcome: 'invalid' });
    expect(await apply('does-not-exist', 'resolve')).toEqual({
      outcome: 'invalid',
    });
  });
});
