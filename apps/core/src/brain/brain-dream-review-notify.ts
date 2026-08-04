import {
  renderBrainReviewCard,
  type BrainReviewCardView,
} from '../domain/brain-review-card.js';

// Owner-DM delivery of a destructive-proposal review (T6). Mirrors the observer
// digest delivery seam: a narrow gateway performs the durable, idempotent
// outbound enqueue; the review card view rides along so the interactive
// Approve/Reject buttons survive delivery and recovery. Not gated on Observer —
// the owner route is resolved by the injected resolveOwner (works Observer-off).

/**
 * The seam that performs the durable outbound enqueue. Kept narrow so the brain
 * pipeline never touches provider transport directly and tests inject a fake.
 * Enqueue is idempotent on `idempotencyKey`, so a retry/re-run never double-posts.
 */
export interface BrainReviewNotifyGateway {
  enqueue(input: {
    appId: string;
    conversationJid: string;
    providerAccountId: string;
    threadId: string | null;
    idempotencyKey: string;
    text: string;
    /** Rendered card + buttons, carried into the durable outbound record so
     * recovery re-renders native buttons; `text` stays the fallback. */
    brainReviewView: BrainReviewCardView;
    // `created` is false when the idempotency key already had a delivery (no new
    // outbound scheduled). The manual re-notify path relies on this to report
    // honestly and to force a fresh send via a generation-suffixed key.
  }): Promise<{ outboundDeliveryId: string; created: boolean }>;
}

/**
 * Idempotency key for a review notification. STARTUP recovery uses the stable
 * base key (`brain-review:<id>`) so orphan-fill stays exactly-once. The MANUAL
 * re-notify passes a `generation` suffix so it forces a FRESH outbound message to
 * the CURRENT owner even when a prior delivery exists under the base key.
 */
export function brainReviewNotifyIdempotencyKey(
  reviewId: string,
  generation?: string,
): string {
  const base = `brain-review:${reviewId}`;
  return generation ? `${base}:r${generation}` : base;
}

export interface NotifiableBrainReview {
  id: string;
  action: string;
  reviewSnapshot: Record<string, unknown>;
}

const ORPHAN_PAGE_SIZE = 200;

/**
 * Recovery pass for ORPHANED notifications only: re-enqueue the owner-DM
 * notification for pending reviews that have NO durable outbound delivery for
 * their `brain-review:<id>` key. Best-effort delivery happens ONCE at intake; a
 * transient owner-resolve/enqueue failure leaves the review an orphan and nothing
 * re-notifies it. Re-enqueuing is idempotent, so re-running is safe.
 *
 * Drain via a (createdAt, id) keyset cursor that advances by the LAST FETCHED row
 * every iteration — regardless of whether that row's notify succeeded. So the pass
 * scans the orphan set forward EXACTLY ONCE: it never re-fetches the front, always
 * advances past a failing prefix to reach deliverable orphans behind it, and
 * terminates on a short page. Delivered orphans drop out of the anti-join for
 * future passes; ones whose notify fails (effectively global — e.g. no verified
 * owner — or transient) stay orphans and are retried on the NEXT startup pass.
 * ponytail: the already-delivered backlog is never scanned (the anti-join excludes
 * it), so no per-pass cap is needed.
 */
export async function redeliverPendingBrainReviews(deps: {
  reviews: {
    listPendingBrainReviewsWithoutDelivery(input: {
      appId: string;
      limit: number;
      after?: { createdAt: string; id: string };
    }): Promise<
      Array<NotifiableBrainReview & { id: string; createdAt: string }>
    >;
  };
  appId: string;
  notify: BrainReviewNotifier;
  pageSize?: number;
}): Promise<{ delivered: number }> {
  const pageSize = deps.pageSize ?? ORPHAN_PAGE_SIZE;
  let delivered = 0;
  let after: { createdAt: string; id: string } | undefined;
  for (;;) {
    const page = await deps.reviews.listPendingBrainReviewsWithoutDelivery({
      appId: deps.appId,
      limit: pageSize,
      after,
    });
    if (page.length === 0) break;
    for (const review of page) {
      const outcome = await deps.notify(review); // never throws
      if (outcome.delivered) delivered += 1;
    }
    // Advance by the last fetched row — NOT by delivery success — so a failing
    // prefix can't pin the scan; failures are retried on the next startup pass.
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
    if (page.length < pageSize) break;
  }
  return { delivered };
}

/** Build the durable card view + fallback text for a review. */
export function buildBrainReviewNotification(review: NotifiableBrainReview): {
  view: BrainReviewCardView;
  text: string;
} {
  const view = renderBrainReviewCard({
    reviewId: review.id,
    action: review.action,
    snapshot: review.reviewSnapshot,
  });
  return { view, text: [view.headline, ...view.details].join('\n') };
}

export interface BrainReviewNotifyOutcome {
  // True when an outbound delivery was created OR already exists for the key.
  // False on a missing verified owner or an enqueue failure (both warned).
  delivered: boolean;
  // True only when THIS call scheduled a NEW outbound message (enqueue created a
  // row). False when the idempotency key already had one. The manual re-notify
  // reports success only on `created`; startup recovery ignores it.
  created: boolean;
  reason?: string;
}

export type BrainReviewNotifier = (
  review: NotifiableBrainReview,
) => Promise<BrainReviewNotifyOutcome>;

/**
 * Bind a notifier to a gateway + owner resolver. Resolves the CURRENT verified
 * owner route and enqueues the review card idempotently. A missing owner or an
 * enqueue failure is logged, never thrown — delivery must never roll back the
 * (already-committed) review; the pending-review list is the recovery handle.
 */
export function createBrainReviewNotifier(deps: {
  gateway: BrainReviewNotifyGateway;
  appId: string;
  resolveOwner: () => Promise<{
    owner?: {
      recipient: string;
      conversationJid: string;
      providerAccountId: string;
    };
  }>;
  // Manual re-notify passes a per-invocation generation → a distinct idempotency
  // key that forces a fresh outbound message even if a prior delivery exists.
  // Omitted by startup recovery (stable key = orphan-fill, no dupes).
  keyGeneration?: string;
  warn?: (context: Record<string, unknown>, message: string) => void;
}): BrainReviewNotifier {
  // Diagnostics must never become the notifier's failure: a throwing logger is
  // swallowed so warn can't escape the never-throw contract.
  const safeWarn = (
    context: Record<string, unknown>,
    message: string,
  ): void => {
    try {
      deps.warn?.(context, message);
    } catch {
      // ponytail: a broken logger can't be reported to itself; drop it.
    }
  };
  return async (review) => {
    // Best-effort contract: ANY failure (owner resolution, render, enqueue) is
    // caught here and reported — the notifier never throws, so a transient DB /
    // enqueue blip can't roll back the already-committed review, and no caller
    // has to add its own catch. The pending-review list is the recovery handle.
    try {
      const { owner } = await deps.resolveOwner();
      if (!owner) {
        const reason = 'no verified owner route configured';
        safeWarn(
          { reviewId: review.id },
          `brain review not delivered: ${reason}`,
        );
        return { delivered: false, created: false, reason };
      }
      const { view, text } = buildBrainReviewNotification(review);
      const { created } = await deps.gateway.enqueue({
        appId: deps.appId,
        conversationJid: owner.conversationJid,
        providerAccountId: owner.providerAccountId,
        threadId: null,
        idempotencyKey: brainReviewNotifyIdempotencyKey(
          review.id,
          deps.keyGeneration,
        ),
        text,
        brainReviewView: view,
      });
      return { delivered: true, created };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      safeWarn(
        { reviewId: review.id, error: reason },
        'brain review notification failed; will surface via the pending-review list',
      );
      return { delivered: false, created: false, reason };
    }
  };
}

// Module-level gateway holder, set at bootstrap (runtime-services) where the
// OutboundDeliveryService lives, mirroring setObserverDigestGateway. Until set,
// the dream batch skips delivery (review still created + surfaced by the pending
// list), and re-delivers once wired.
let brainReviewNotifyGateway: BrainReviewNotifyGateway | null = null;

export function setBrainReviewNotifyGateway(
  gateway: BrainReviewNotifyGateway | null,
): void {
  brainReviewNotifyGateway = gateway;
}

export function getBrainReviewNotifyGateway(): BrainReviewNotifyGateway | null {
  return brainReviewNotifyGateway;
}
