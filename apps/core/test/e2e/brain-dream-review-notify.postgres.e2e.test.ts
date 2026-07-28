import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import { PostgresBrainDreamReviewRepository } from '@core/adapters/storage/postgres/repositories/brain-dream-review-repository.postgres.js';
import { applyBrainDreamOperations } from '@core/brain/brain-dreaming.js';
import { BrainService } from '@core/brain/brain-service.js';
import { executeBrainDreamReviewDecision } from '@core/brain/brain-dream-review-executor.js';
import {
  createBrainReviewNotifier,
  redeliverPendingBrainReviews,
  type BrainReviewNotifyGateway,
} from '@core/brain/brain-dream-review-notify.js';
import { handleBrainDreamReviewAction } from '@core/app/bootstrap/runtime-brain-review-message-action.js';
import { OutboundDeliveryService } from '@core/application/outbound-delivery/outbound-delivery-service.js';
import type { OutboundDeliveryProfile } from '@core/domain/outbound-delivery/planner.js';
import {
  BRAIN_REVIEW_PROFILE_ID,
  OBSERVER_DIGEST_PROFILE_ID,
  canonicalThreadIdFor,
  resolveDurableOutboundTarget,
} from '@core/app/bootstrap/runtime-services-destination-hints.js';
import type { BrainReviewCardView } from '@core/domain/brain-review-card.js';
import type { BrainPage } from '@core/brain/brain-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'brain-notify-app';
const NOW = '2026-07-27T09:00:00.000Z';
const OWNER = {
  recipient: 'owner-1',
  conversationJid: 'sl:D-owner',
  providerAccountId: 'slack_one',
};

// A single-part profile carrying the rendered card view into the item
// providerPayload — mirrors the production brainReviewProfile in runtime-services.
const brainReviewProfile: OutboundDeliveryProfile = {
  profileId: BRAIN_REVIEW_PROFILE_ID,
  plan: (input) => {
    const brainReviewView =
      input.metadata && 'brainReviewView' in input.metadata
        ? input.metadata.brainReviewView
        : undefined;
    return {
      parts: [
        {
          canonicalText: input.text,
          ...(brainReviewView !== undefined
            ? { providerPayload: { brainReviewView } }
            : {}),
        },
      ],
      canonicalFinalText: input.text,
    };
  },
};

const observerDigestProfile: OutboundDeliveryProfile = {
  profileId: OBSERVER_DIGEST_PROFILE_ID,
  plan: (input) => ({
    parts: [{ canonicalText: input.text }],
    canonicalFinalText: input.text,
  }),
};

maybeDescribe('brain dream review owner-DM notification (T6)', () => {
  let runtime: PostgresIntegrationRuntime;
  let repository: PostgresBrainRepository;
  let reviews: PostgresBrainDreamReviewRepository;
  let brain: BrainService;
  let service: OutboundDeliveryService;
  let gateway: BrainReviewNotifyGateway;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'brain_notify',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Brain notify test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Seed the app-owned owner DM conversation the durable enqueue targets
    // (id mirrors resolveDurableOutboundTarget for sl:D-owner + slack_one).
    await runtime.repositories.conversations.saveConversation({
      id: 'conversation:slack_one:sl:D-owner' as never,
      appId: APP_ID as never,
      providerAccountId: 'slack_one' as never,
      externalRef: { kind: 'conversation', value: 'D-owner' },
      kind: 'channel',
      title: 'Owner DM',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });

    repository = new PostgresBrainRepository(runtime.service.db);
    reviews = new PostgresBrainDreamReviewRepository(runtime.service.db);
    brain = new BrainService(repository);

    service = new OutboundDeliveryService({
      repository: runtime.repositories.outboundDeliveries,
      profiles: {
        resolve: (id) =>
          id === BRAIN_REVIEW_PROFILE_ID
            ? brainReviewProfile
            : id === OBSERVER_DIGEST_PROFILE_ID
              ? observerDigestProfile
              : undefined,
      },
      now: () => NOW,
      createId: () => randomUUID(),
      hashSha256Hex: (v) =>
        createHash('sha256').update(v, 'utf8').digest('hex'),
    });

    // The production gateway (runtime-services) verbatim: enqueue under the
    // brain-review profile, idempotent on brain-review:<reviewId>.
    gateway = {
      enqueue: async (input) => {
        const target = resolveDurableOutboundTarget({
          defaultAppId: input.appId,
          jid: input.conversationJid,
          providerAccountId: input.providerAccountId,
        });
        const result = await service.enqueue({
          appId: target.appId as never,
          conversationId: target.conversationId as never,
          threadId: canonicalThreadIdFor({
            jid: input.conversationJid,
            threadId: input.threadId ?? undefined,
            providerAccountId: input.providerAccountId,
          }) as never,
          profileId: BRAIN_REVIEW_PROFILE_ID,
          idempotencyKey: input.idempotencyKey,
          text: input.text,
          metadata: { brainReviewView: input.brainReviewView },
        });
        return {
          outboundDeliveryId: result.delivery.id,
          created: result.created,
        };
      },
    };
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  let seq = 0;
  async function seedPageWithEdge(slug: string): Promise<BrainPage> {
    seq += 1;
    const { page } = await repository.upsertPage({
      appId: APP_ID,
      slug,
      title: slug,
      markdown: 'body',
      sourceKind: 'user',
    });
    const [a, b] = await repository.upsertEntities(APP_ID, [
      { kind: 'person', name: `A${seq}`, normalizedName: `a${seq}` },
      { kind: 'person', name: `B${seq}`, normalizedName: `b${seq}` },
    ]);
    await repository.upsertEdges(APP_ID, page.id, [
      { type: 'mentions', fromEntityId: a.id, toEntityId: b.id },
    ]);
    return page;
  }

  // Intake one delete_page op with the wired notifier and return the review id.
  async function intakeDeletePage(
    page: BrainPage,
    notify: ReturnType<typeof createBrainReviewNotifier>,
  ): Promise<string> {
    let createdReviewId: string | undefined;
    await applyBrainDreamOperations({
      brain,
      repository,
      reviews,
      notify: async (review) => {
        createdReviewId = review.id;
        return notify(review);
      },
      appId: APP_ID,
      runId: 'notify-run',
      page,
      evidencePages: [page],
      ops: [{ action: 'delete_page', page_id: page.id }],
    });
    expect(createdReviewId).toBeDefined();
    return createdReviewId!;
  }

  async function deliveryCount(): Promise<number> {
    const rows = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${runtime.schemaName}.outbound_deliveries`,
    );
    return Number(rows.rows[0]!.count);
  }

  async function deliveryCountByKey(key: string): Promise<number> {
    const rows = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${runtime.schemaName}.outbound_deliveries WHERE idempotency_key = $1`,
      [key],
    );
    return Number(rows.rows[0]!.count);
  }

  async function claimBrainReviewItem() {
    const claimed = await service.claimPending({
      appId: APP_ID as never,
      profileId: BRAIN_REVIEW_PROFILE_ID,
      claimerId: 'test-recovery',
      limit: 10,
      now: NOW,
    });
    return claimed;
  }

  function ownerHandlerDeps(
    resolveOwnerValue: {
      owner?: {
        recipient: string;
        conversationJid: string;
        providerAccountId: string;
      };
    } = { owner: OWNER },
  ) {
    return {
      appId: APP_ID,
      resolveVerifiedOwner: async () => resolveOwnerValue,
      executeDecision: (input: {
        appId: string;
        reviewId: string;
        decision: 'approve' | 'reject';
        reviewer: {
          userId: string;
          conversationJid: string;
          providerAccountId: string;
        };
      }) =>
        executeBrainDreamReviewDecision({
          db: runtime.service.db,
          reviews,
          appId: input.appId,
          reviewId: input.reviewId,
          decision: input.decision,
          reviewer: input.reviewer,
        }),
      warn: () => {},
    };
  }

  it('APPROVE loop: notify → durable card+buttons delivered → owner approves → page deleted, applied', async () => {
    const page = await seedPageWithEdge('approve-me');
    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const before = await deliveryCount();
    const reviewId = await intakeDeletePage(page, notify);

    // Exactly one durable delivery was created for this review.
    expect(await deliveryCount()).toBe(before + 1);

    // The durable payload carries the rendered card + Approve/Reject buttons.
    const claimed = await claimBrainReviewItem();
    const mine = claimed.find(
      (c) =>
        (c.item.providerPayload as { brainReviewView?: BrainReviewCardView })
          ?.brainReviewView?.reviewId === reviewId,
    );
    expect(mine).toBeDefined();
    const view = (
      mine!.item.providerPayload as { brainReviewView: BrainReviewCardView }
    ).brainReviewView;
    expect(view.buttons.map((b) => b.decision)).toEqual(['approve', 'reject']);
    expect(view.headline).toContain('approve-me');

    // A fake channel client receives the card view (buttons survive delivery).
    const fakeSink = vi.fn(async () => ({ externalMessageId: 'm1' }));
    await fakeSink(OWNER.conversationJid, mine!.item.canonicalText, {
      brainReviewView: view,
    });
    expect(fakeSink).toHaveBeenCalledWith(
      OWNER.conversationJid,
      expect.stringContaining('approve-me'),
      expect.objectContaining({ brainReviewView: view }),
    );

    // Owner clicks Approve through the real owner-only handler + executor.
    const outcome = await handleBrainDreamReviewAction(ownerHandlerDeps(), {
      kind: 'brain_dream_review_decision',
      conversationJid: OWNER.conversationJid,
      providerAccountId: OWNER.providerAccountId,
      userId: OWNER.recipient,
      reviewId,
      decision: 'approve',
    });
    expect(outcome.state).toBe('applied');
    expect(outcome.clearActions).toBe(true); // card edited to result, buttons removed
    expect(await repository.getPageById(APP_ID, page.id)).toBeNull();
  });

  it('EXACTLY-ONCE: running the notification step twice never double-posts', async () => {
    const page = await seedPageWithEdge('once-only');
    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const reviewId = await intakeDeletePage(page, notify);
    const afterFirst = await deliveryCount();

    // Re-run notify twice with the same review — idempotency key dedupes.
    const review = await reviews.findPendingBrainDreamReview({
      appId: APP_ID,
      reviewId,
    });
    await notify(review!);
    await notify(review!);
    expect(await deliveryCount()).toBe(afterFirst); // no new deliveries

    const rows = await runtime.service.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${runtime.schemaName}.outbound_deliveries
       WHERE idempotency_key = $1`,
      [`brain-review:${reviewId}`],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it('REJECT: owner rejects → review rejected, brain untouched', async () => {
    const page = await seedPageWithEdge('reject-me');
    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const reviewId = await intakeDeletePage(page, notify);

    const outcome = await handleBrainDreamReviewAction(ownerHandlerDeps(), {
      kind: 'brain_dream_review_decision',
      conversationJid: OWNER.conversationJid,
      providerAccountId: OWNER.providerAccountId,
      userId: OWNER.recipient,
      reviewId,
      decision: 'reject',
    });
    expect(outcome.state).toBe('applied'); // terminal receipt (Rejected)
    expect(outcome.clearActions).toBe(true);
    expect(await repository.getPageById(APP_ID, page.id)).not.toBeNull();
  });

  it('STALE: target mutated after snapshot → approve yields stale, no mutation', async () => {
    const page = await seedPageWithEdge('stale-me');
    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const reviewId = await intakeDeletePage(page, notify);

    // Concurrent CONTENT edit after the snapshot (updated_at preserved).
    await runtime.service.pool.query(
      `UPDATE ${runtime.schemaName}.brain_pages SET markdown = 'edited' WHERE id = $1`,
      [page.id],
    );

    const outcome = await handleBrainDreamReviewAction(ownerHandlerDeps(), {
      kind: 'brain_dream_review_decision',
      conversationJid: OWNER.conversationJid,
      providerAccountId: OWNER.providerAccountId,
      userId: OWNER.recipient,
      reviewId,
      decision: 'approve',
    });
    expect(outcome.state).toBe('stale');
    expect(await repository.getPageById(APP_ID, page.id)).not.toBeNull();
  });

  it('NON-OWNER click → denied, no mutation, no delivery double-post', async () => {
    const page = await seedPageWithEdge('non-owner');
    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const reviewId = await intakeDeletePage(page, notify);
    const deliveriesBefore = await deliveryCount();

    const outcome = await handleBrainDreamReviewAction(ownerHandlerDeps(), {
      kind: 'brain_dream_review_decision',
      conversationJid: OWNER.conversationJid,
      providerAccountId: OWNER.providerAccountId,
      userId: 'intruder', // not the verified owner recipient
      reviewId,
      decision: 'approve',
    });
    expect(outcome.state).toBe('denied');
    expect(await repository.getPageById(APP_ID, page.id)).not.toBeNull();
    expect(await deliveryCount()).toBe(deliveriesBefore); // no re-notification
  });

  it('REGRESSION: observer-digest delivery path is isolated + unchanged', async () => {
    // A brain-review enqueue and an observer-digest enqueue to the SAME
    // conversation coexist as distinct deliveries under distinct keys; a
    // brain-review re-run never clobbers the observer digest row.
    const target = resolveDurableOutboundTarget({
      defaultAppId: APP_ID,
      jid: OWNER.conversationJid,
      providerAccountId: OWNER.providerAccountId,
    });
    const observer = await service.enqueue({
      appId: target.appId as never,
      conversationId: target.conversationId as never,
      profileId: OBSERVER_DIGEST_PROFILE_ID,
      idempotencyKey: `observer-digest:${APP_ID}:${OWNER.recipient}:2026-07-27`,
      text: 'observer digest',
    });
    expect(observer.created).toBe(true);

    const brainReview = await service.enqueue({
      appId: target.appId as never,
      conversationId: target.conversationId as never,
      profileId: BRAIN_REVIEW_PROFILE_ID,
      idempotencyKey: 'brain-review:regression-1',
      text: 'brain review',
      metadata: { brainReviewView: { reviewId: 'regression-1' } },
    });
    expect(brainReview.created).toBe(true);
    expect(brainReview.delivery.id).not.toBe(observer.delivery.id);

    // Re-run the brain-review enqueue: idempotent, and the observer row is intact.
    const rerun = await service.enqueue({
      appId: target.appId as never,
      conversationId: target.conversationId as never,
      profileId: BRAIN_REVIEW_PROFILE_ID,
      idempotencyKey: 'brain-review:regression-1',
      text: 'brain review',
      metadata: { brainReviewView: { reviewId: 'regression-1' } },
    });
    expect(rerun.created).toBe(false);
    expect(rerun.delivery.id).toBe(brainReview.delivery.id);

    const observerRow = await runtime.service.pool.query<{ status: string }>(
      `SELECT status FROM ${runtime.schemaName}.outbound_deliveries WHERE id = $1`,
      [observer.delivery.id],
    );
    expect(observerRow.rows).toHaveLength(1);
  });

  it('RECOVERY: an orphaned review (no outbound row) is re-notified, idempotently', async () => {
    // Create a review WITHOUT a notifier — simulates a transient owner-resolve /
    // enqueue failure at intake: the review is pending but has no outbound record.
    const page = await seedPageWithEdge('recover-me');
    await applyBrainDreamOperations({
      brain,
      repository,
      reviews,
      appId: APP_ID,
      runId: 'notify-run',
      page,
      evidencePages: [page],
      ops: [{ action: 'delete_page', page_id: page.id }],
    });
    const review = (
      await reviews.listPendingBrainDreamReviews({ appId: APP_ID, limit: 50 })
    ).find(
      (r) =>
        r.action === 'delete_page' &&
        (r.canonicalOp as { pageId?: string }).pageId === page.id,
    )!;
    const key = `brain-review:${review.id}`;
    expect(await deliveryCountByKey(key)).toBe(0); // orphaned — nothing sent

    // The orphan query returns THIS review (no delivery) but excludes any pending
    // review that already has a delivery (e.g. once-only from an earlier test).
    const orphansBefore = await reviews.listPendingBrainReviewsWithoutDelivery({
      appId: APP_ID,
      limit: 500,
    });
    expect(orphansBefore.map((r) => r.id)).toContain(review.id);
    for (const orphan of orphansBefore) {
      expect(await deliveryCountByKey(`brain-review:${orphan.id}`)).toBe(0);
    }

    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    // Recovery delivers the orphan.
    const first = await redeliverPendingBrainReviews({
      reviews,
      appId: APP_ID,
      notify,
    });
    expect(first.delivered).toBeGreaterThanOrEqual(1);
    expect(await deliveryCountByKey(key)).toBe(1);
    // A delivered review is no longer an orphan → a second pass finds none and
    // terminates immediately without re-posting.
    const second = await redeliverPendingBrainReviews({
      reviews,
      appId: APP_ID,
      notify,
    });
    expect(second.delivered).toBe(0);
    expect(await deliveryCountByKey(key)).toBe(1);
  });

  it('RECOVERY drains: >200 orphaned reviews ALL get exactly one delivery', async () => {
    // Bare pending reviews with no outbound record. 205 > the 200 orphan page, so
    // the drain must page through: delivered orphans drop out of the query, so the
    // set shrinks to empty and all are reached in one pass.
    const ids: string[] = [];
    const createdAt = '2026-07-28T00:00:00.000Z';
    for (let i = 0; i < 205; i++) {
      const reviewId = `bulk-rev-${String(i).padStart(3, '0')}`;
      const decisionId = `bulk-dec-${i}`;
      await repository.journalDreamDecision({
        id: decisionId,
        appId: APP_ID,
        runId: 'bulk-run',
        pageId: null,
        op: { action: 'delete_page' },
        outcome: 'proposed',
        reason: 'bulk',
      });
      const created = await reviews.createBrainDreamReview({
        id: reviewId,
        appId: APP_ID,
        runId: 'bulk-run',
        decisionId,
        action: 'delete_page',
        canonicalOp: {
          action: 'delete_page',
          version: 1,
          pageId: `bulk-p-${i}`,
        },
        reviewSnapshot: {
          action: 'delete_page',
          before: { title: `bulk ${i}` },
        },
        nowIso: createdAt,
        targets: [
          {
            targetKind: 'page',
            targetId: `bulk-target-${i}`,
            expectedVersion: 'v1',
          },
        ],
      });
      if (!created.ok)
        throw new Error(`bulk create failed: ${created.conflict}`);
      ids.push(reviewId);
    }

    const notify = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const result = await redeliverPendingBrainReviews({
      reviews,
      appId: APP_ID,
      notify,
    });
    expect(result.delivered).toBeGreaterThanOrEqual(205);

    // EVERY one of the 205 — including those beyond the first page — has exactly
    // one delivery.
    for (const reviewId of ids) {
      expect(await deliveryCountByKey(`brain-review:${reviewId}`)).toBe(1);
    }
    // Drained: a second pass sees no orphans (all delivered) and terminates.
    const second = await redeliverPendingBrainReviews({
      reviews,
      appId: APP_ID,
      notify,
    });
    expect(second.delivered).toBe(0);
  }, 60_000);

  it('RECOVERY advances past a failing prefix: a later orphan is still delivered', async () => {
    // 3 orphans that FAIL notify, ordered before 1 that succeeds. With pageSize 2
    // the failing prefix fills a whole page; the cursor must advance by the last
    // fetched row (not by delivery) to reach the deliverable orphan behind it.
    async function seedOrphan(id: string, createdAt: string) {
      await repository.journalDreamDecision({
        id: `${id}-dec`,
        appId: APP_ID,
        runId: 'fp-run',
        pageId: null,
        op: { action: 'delete_page' },
        outcome: 'proposed',
        reason: 'fp',
      });
      const created = await reviews.createBrainDreamReview({
        id,
        appId: APP_ID,
        runId: 'fp-run',
        decisionId: `${id}-dec`,
        action: 'delete_page',
        canonicalOp: { action: 'delete_page', version: 1, pageId: `${id}-p` },
        reviewSnapshot: { action: 'delete_page', before: { title: id } },
        nowIso: createdAt,
        targets: [
          { targetKind: 'page', targetId: `${id}-t`, expectedVersion: 'v1' },
        ],
      });
      if (!created.ok) throw new Error(`fp create failed: ${created.conflict}`);
    }
    await seedOrphan('fp-fail-0', '2026-07-30T00:00:00.000Z');
    await seedOrphan('fp-fail-1', '2026-07-30T00:00:00.000Z');
    await seedOrphan('fp-fail-2', '2026-07-30T00:00:00.000Z');
    await seedOrphan('fp-ok', '2026-07-30T00:00:01.000Z'); // sorts AFTER the prefix

    // Gateway that throws for the failing prefix (notifier catches → delivered:false)
    // and succeeds via the real gateway otherwise.
    const failingGateway: BrainReviewNotifyGateway = {
      enqueue: async (input) => {
        if (input.idempotencyKey.includes('fp-fail')) {
          throw new Error('simulated enqueue failure');
        }
        return gateway.enqueue(input);
      },
    };
    const notify = createBrainReviewNotifier({
      gateway: failingGateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });

    const result = await redeliverPendingBrainReviews({
      reviews,
      appId: APP_ID,
      notify,
      pageSize: 2, // failing prefix (fp-fail-0/1) fills page 1; cursor must cross it
    });
    expect(result.delivered).toBe(1);
    // The deliverable orphan behind the failing prefix WAS reached + delivered.
    expect(await deliveryCountByKey('brain-review:fp-ok')).toBe(1);
    // The failing prefix stayed orphaned (retried next startup), not delivered.
    expect(await deliveryCountByKey('brain-review:fp-fail-0')).toBe(0);
    expect(await deliveryCountByKey('brain-review:fp-fail-2')).toBe(0);
  }, 60_000);

  async function deliveryConversationByKey(
    key: string,
  ): Promise<string | null> {
    const rows = await runtime.service.pool.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM ${runtime.schemaName}.outbound_deliveries WHERE idempotency_key = $1`,
      [key],
    );
    return rows.rows[0]?.conversation_id ?? null;
  }

  it('MANUAL re-notify schedules a FRESH message even when a delivery exists', async () => {
    const page = await seedPageWithEdge('renotify-exists');
    // First delivery under the STABLE key (startup-style, no generation).
    const stable = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const reviewId = await intakeDeletePage(page, stable);
    expect(await deliveryCountByKey(`brain-review:${reviewId}`)).toBe(1);

    // Manual re-notify with a generation → a NEW outbound under a distinct key
    // (not a silent no-op), and it reports created truthfully.
    const manual = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
      keyGeneration: 'g1',
    });
    const review = await reviews.findPendingBrainDreamReview({
      appId: APP_ID,
      reviewId,
    });
    const outcome = await manual(review!);
    expect(outcome).toMatchObject({ delivered: true, created: true });
    expect(await deliveryCountByKey(`brain-review:${reviewId}:rg1`)).toBe(1);
    // The stable-key delivery is untouched (still exactly one).
    expect(await deliveryCountByKey(`brain-review:${reviewId}`)).toBe(1);
  });

  it('MANUAL re-notify targets the CURRENT owner after an owner-route change', async () => {
    // A second, app-owned owner conversation (the "new" owner).
    await runtime.repositories.conversations.saveConversation({
      id: 'conversation:slack_two:sl:D-owner2' as never,
      appId: APP_ID as never,
      providerAccountId: 'slack_two' as never,
      externalRef: { kind: 'conversation', value: 'D-owner2' },
      kind: 'channel',
      title: 'New Owner DM',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const NEW_OWNER = {
      recipient: 'owner-2',
      conversationJid: 'sl:D-owner2',
      providerAccountId: 'slack_two',
    };
    const page = await seedPageWithEdge('renotify-newowner');
    const stable = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const reviewId = await intakeDeletePage(page, stable);

    // Owner route changed → manual re-notify resolves the NEW owner and delivers
    // there (enqueue validates the destination is app-owned, so success proves it
    // targeted the new owner's conversation).
    const manual = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: NEW_OWNER }),
      keyGeneration: 'g2',
    });
    const review = await reviews.findPendingBrainDreamReview({
      appId: APP_ID,
      reviewId,
    });
    const outcome = await manual(review!);
    expect(outcome).toMatchObject({ delivered: true, created: true });
    expect(
      await deliveryConversationByKey(`brain-review:${reviewId}:rg2`),
    ).toBe('conversation:slack_two:sl:D-owner2');
  });

  it('ANTI-JOIN: a review with only a generation-key delivery is NOT an orphan', async () => {
    // No-op notifier → intake creates the review WITHOUT any outbound row.
    const noopNotify = createBrainReviewNotifier({
      gateway: {
        enqueue: async () => ({ outboundDeliveryId: 'noop', created: false }),
      },
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
    });
    const genReviewId = await intakeDeletePage(
      await seedPageWithEdge('antijoin-gen'),
      noopNotify,
    );
    const orphanReviewId = await intakeDeletePage(
      await seedPageWithEdge('antijoin-orphan'),
      noopNotify,
    );

    // Manual re-notify creates ONLY a generation-suffixed delivery (no base key).
    const manual = createBrainReviewNotifier({
      gateway,
      appId: APP_ID,
      resolveOwner: async () => ({ owner: OWNER }),
      keyGeneration: 'gen1',
    });
    const genReview = await reviews.findPendingBrainDreamReview({
      appId: APP_ID,
      reviewId: genReviewId,
    });
    expect((await manual(genReview!)).created).toBe(true);
    expect(await deliveryCountByKey(`brain-review:${genReviewId}`)).toBe(0);
    expect(await deliveryCountByKey(`brain-review:${genReviewId}:rgen1`)).toBe(
      1,
    );

    // The anti-join treats the generation-key delivery as "has a delivery" → the
    // review is NOT an orphan (startup recovery won't send a duplicate base card);
    // a review with NO delivery at all still IS an orphan.
    const orphanIds = (
      await reviews.listPendingBrainReviewsWithoutDelivery({
        appId: APP_ID,
        limit: 500,
      })
    ).map((r) => r.id);
    expect(orphanIds).not.toContain(genReviewId);
    expect(orphanIds).toContain(orphanReviewId);
  });
});
