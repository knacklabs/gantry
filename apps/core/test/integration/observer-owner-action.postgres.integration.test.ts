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
  recipient: string = RECIPIENT,
): Promise<void> {
  const claimed = await repo.claimPendingForDigest({
    appId: APP_ID,
    recipient,
    limit: 50,
    nowIso: NOW,
  });
  const reserve = await repo.reserveDigest({
    id: reservationId,
    appId: APP_ID,
    recipient,
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
    last_feedback_at: string;
    updated_at: string;
  } | null> {
    const { rows } = await runtime.service.pool.query<{
      negative_count: number;
      suppressed_until: string | null;
      last_feedback_at: string;
      updated_at: string;
    }>(
      `SELECT negative_count, suppressed_until, last_feedback_at, updated_at
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

  // All beforeAll insights were delivered by delivery-1, so that is the button's
  // delivery for these clicks.
  const apply = (
    insightId: string,
    action: string,
    deliveryId = 'delivery-1',
  ) =>
    repo.applyOwnerAction({
      appId: APP_ID,
      recipient: RECIPIENT,
      actorUserId: ACTOR,
      insightId,
      action: action as never,
      deliveryId,
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
        deliveryId: 'delivery-1',
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
        deliveryId: 'delivery-1',
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
    // updated_at must not rewind below its prior value or below last_feedback_at.
    expect(Date.parse(afterEarly!.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(before!.updated_at),
    );
    expect(Date.parse(afterEarly!.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(afterEarly!.last_feedback_at),
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
        deliveryId: 'delivery-1',
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

  it('listOwnerActionsForInsights: a NEWER snooze beats an OLDER resolve (time wins over terminal preference)', async () => {
    // Feedback rows are inserted directly to control created_at: applyOwnerAction
    // can't produce resolve-then-later-snooze (resolve is terminal). Newest time
    // must win, so the snooze — not the older resolve — is the marker.
    await repo.create(insight('ord'));
    // Both rows share delivery-1 (same occurrence) to isolate the tiebreak.
    const insertFeedback = (action: string, createdAt: string) =>
      runtime.service.pool.query(
        `INSERT INTO "${runtime.schemaName}".observer_insight_feedback
           (id, app_id, recipient, insight_id, delivery_id, actor_user_id, insight_type, action, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          `oif_ord_${action}`,
          APP_ID,
          RECIPIENT,
          'ord',
          'delivery-1',
          ACTOR,
          'commitment',
          action,
          createdAt,
        ],
      );
    await insertFeedback('resolve', '2026-07-22T08:00:00.000Z');
    await insertFeedback('snooze', '2026-07-22T10:00:00.000Z'); // newer
    for (let i = 0; i < 5; i += 1) {
      const actions = await repo.listOwnerActionsForInsights({
        appId: APP_ID,
        recipient: RECIPIENT,
        insightIds: ['ord'],
        deliveryId: 'delivery-1',
      });
      expect(actions.get('ord')).toBe('snooze');
    }
  });

  it('listOwnerActionsForInsights: terminal action outranks a SAME-timestamp snooze, deterministically', async () => {
    // A snooze then a resolve at the IDENTICAL createdAt (same nowIso). The
    // terminal resolve must win every rebuild — the ORDER BY breaks the tie.
    await repo.create(insight('lw'));
    await deliverToCooldown(repo, 'delivery-lw', '2026-07-23');
    const commonArgs = {
      appId: APP_ID,
      recipient: RECIPIENT,
      actorUserId: ACTOR,
      insightId: 'lw',
      deliveryId: 'delivery-lw',
      nowIso: NOW, // SAME timestamp for both rows
      snoozeMs: SNOOZE_MS,
      suppressMs: SUPPRESS_MS,
      suppressThreshold: THRESHOLD,
    };
    await repo.applyOwnerAction({ ...commonArgs, action: 'snooze' });
    await repo.applyOwnerAction({ ...commonArgs, action: 'resolve' });

    // Repeat the read to prove the tiebreak is stable, not luck-of-the-scan.
    for (let i = 0; i < 5; i += 1) {
      const actions = await repo.listOwnerActionsForInsights({
        appId: APP_ID,
        recipient: RECIPIENT,
        insightIds: ['lw'],
        deliveryId: 'delivery-lw',
      });
      expect(actions.get('lw')).toBe('resolve');
    }

    // Delivery-1 scope: res -> resolve, dis -> dismiss; lw (delivery-lw) absent.
    const actions = await repo.listOwnerActionsForInsights({
      appId: APP_ID,
      recipient: RECIPIENT,
      insightIds: ['res', 'dis', 'lw', 'does-not-exist'],
      deliveryId: 'delivery-1',
    });
    expect(actions.get('res')).toBe('resolve');
    expect(actions.get('dis')).toBe('dismiss');
    expect(actions.has('lw')).toBe(false);
    expect(actions.has('does-not-exist')).toBe(false);
    // Owner-scoped: a different recipient sees none of these.
    expect(
      (
        await repo.listOwnerActionsForInsights({
          appId: APP_ID,
          recipient: 'owner:someone-else',
          insightIds: ['res', 'dis'],
          deliveryId: 'delivery-1',
        })
      ).size,
    ).toBe(0);
    // Empty input short-circuits to an empty map.
    expect(
      (
        await repo.listOwnerActionsForInsights({
          appId: APP_ID,
          recipient: RECIPIENT,
          insightIds: [],
          deliveryId: 'delivery-1',
        })
      ).size,
    ).toBe(0);
  });

  it('an insight outside (app,recipient) is invalid', async () => {
    expect(
      await repo.applyOwnerAction({
        appId: APP_ID,
        recipient: 'owner:someone-else',
        actorUserId: ACTOR,
        insightId: 'snz',
        action: 'resolve',
        deliveryId: 'delivery-1',
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

  it('claimPendingForDigest excludes a suppressed-type pending backlog insight while active, claims it once expired', async () => {
    const R = 'owner:suppressed-1';
    await repo.create(
      insight('sup-a', {
        recipient: R,
        insightType: 'stale_fact',
        canonicalSignature: 'sig:sup-a',
      }),
    );
    // Active suppression on stale_fact for R (suppressed_until = NOW + 1 day).
    await runtime.service.pool.query(
      `INSERT INTO "${runtime.schemaName}".observer_insight_type_suppressions
         (app_id, recipient, insight_type, negative_count, suppressed_until, last_feedback_at, updated_at)
       VALUES ($1, $2, 'stale_fact', 2, $3, $4, $4)`,
      [APP_ID, R, '2026-07-23T08:00:00.000Z', NOW],
    );
    // While suppressed: the pending backlog insight is NOT claimed.
    expect(
      await repo.claimPendingForDigest({
        appId: APP_ID,
        recipient: R,
        limit: 10,
        nowIso: NOW,
      }),
    ).toEqual([]);
    // After the window expires (suppressed_until < nowIso): it IS claimed.
    const claimed = await repo.claimPendingForDigest({
      appId: APP_ID,
      recipient: R,
      limit: 10,
      nowIso: '2026-07-24T08:00:00.000Z',
    });
    expect(claimed.map((row) => row.id)).toEqual(['sup-a']);
  });

  it('scopes feedback to the delivery occurrence across a redelivery', async () => {
    const R = 'owner:redeliver-1';
    await repo.create(
      insight('rd', { recipient: R, canonicalSignature: 'sig:rd' }),
    );
    const args = (deliveryId: string, action: string, nowIso: string) => ({
      appId: APP_ID,
      recipient: R,
      actorUserId: ACTOR,
      insightId: 'rd',
      action: action as never,
      deliveryId,
      nowIso,
      snoozeMs: SNOOZE_MS,
      suppressMs: SUPPRESS_MS,
      suppressThreshold: THRESHOLD,
    });
    const cooldownOf = async (): Promise<string> => {
      const { rows } = await runtime.service.pool.query<{
        cooldown_until: string;
      }>(
        `SELECT cooldown_until FROM "${runtime.schemaName}".proactive_insights WHERE id = 'rd'`,
      );
      return rows[0]!.cooldown_until;
    };

    // Delivery 1 → cooldown; snooze it (applied, extends cooldown).
    await deliverToCooldown(repo, 'd-rd-1', '2026-07-22', R);
    expect(await repo.applyOwnerAction(args('d-rd-1', 'snooze', NOW))).toEqual({
      outcome: 'applied',
    });

    // Simulate cooldown expiry → back to pending → REDELIVER as delivery 2.
    await runtime.service.pool.query(
      `UPDATE "${runtime.schemaName}".proactive_insights SET state = 'pending' WHERE id = 'rd'`,
    );
    await deliverToCooldown(repo, 'd-rd-2', '2026-07-29', R);
    const cooldownAfterRedeliver = await cooldownOf();

    // (c) A rebuild of delivery 2 does NOT reflect delivery 1's snooze — so the
    // old action can't clear the new digest's buttons.
    const d2Before = await repo.listOwnerActionsForInsights({
      appId: APP_ID,
      recipient: R,
      insightIds: ['rd'],
      deliveryId: 'd-rd-2',
    });
    expect(d2Before.has('rd')).toBe(false);

    // (a) STALE old-delivery button (d-rd-1) → stale, insight NOT mutated.
    expect(
      await repo.applyOwnerAction(
        args('d-rd-1', 'resolve', '2026-07-29T09:00:00.000Z'),
      ),
    ).toEqual({ outcome: 'stale' });
    const rd = await repo.findInsightForOwnerAction({
      appId: APP_ID,
      recipient: R,
      insightId: 'rd',
    });
    expect(rd?.insight.state).toBe('cooldown'); // not resolved

    // (b) Legitimate re-snooze in delivery 2 → NEW row (not `already`) + cooldown extends.
    const LATER = '2026-07-29T10:00:00.000Z';
    expect(
      await repo.applyOwnerAction(args('d-rd-2', 'snooze', LATER)),
    ).toEqual({ outcome: 'applied' });
    expect(await feedbackCount('rd')).toBe(2); // one row per delivery
    expect(Date.parse(await cooldownOf())).toBeGreaterThan(
      Date.parse(cooldownAfterRedeliver),
    );
    // Rebuild of delivery 2 now shows only its own snooze.
    const d2After = await repo.listOwnerActionsForInsights({
      appId: APP_ID,
      recipient: R,
      insightIds: ['rd'],
      deliveryId: 'd-rd-2',
    });
    expect(d2After.get('rd')).toBe('snooze');

    // (d) Double-click within delivery 2 stays idempotent (no new row).
    expect(
      await repo.applyOwnerAction(args('d-rd-2', 'snooze', LATER)),
    ).toEqual({ outcome: 'applied', already: true });
    expect(await feedbackCount('rd')).toBe(2);
  });
});
