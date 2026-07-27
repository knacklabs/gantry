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
  }): Promise<{ outboundDeliveryId: string }>;
}

/** Stable, per-review idempotency key: exactly ONE notification per review. */
export function brainReviewNotifyIdempotencyKey(reviewId: string): string {
  return `brain-review:${reviewId}`;
}

export interface NotifiableBrainReview {
  id: string;
  action: string;
  reviewSnapshot: Record<string, unknown>;
}

const REDELIVER_PAGE_SIZE = 200;

/**
 * Recovery pass for orphaned notifications: re-enqueue EVERY pending review's
 * owner-DM notification, paging forward to COMPLETION. Best-effort delivery
 * happens ONCE at intake; a transient owner-resolve/enqueue failure leaves the
 * review pending with no outbound record and nothing re-notifies it. Re-enqueuing
 * is safe to repeat — the enqueue is idempotent on `brain-review:<reviewId>`, so a
 * review that already has a delivery is a no-op and an orphan gets a fresh record
 * for the outbound recovery loop to send. Re-notifying does NOT clear the pending
 * state, so we page by (createdAt, id) keyset until a short page arrives, never
 * re-scanning the first page.
 *
 * ponytail: no per-pass cap — scan the whole set. The pending destructive-review
 * set is inherently SMALL (an owner acts on each proposal, so it doesn't grow like
 * a message queue), so a full scan per startup is cheap. A fixed cap would instead
 * STARVE rows past it forever, since a delivered review stays pending and every
 * run restarts from the top. If the pending set ever DID grow large, add a
 * persistent/rotating cursor across process starts so each run advances a slice.
 */
export async function redeliverPendingBrainReviews(deps: {
  reviews: {
    listPendingBrainDreamReviews(input: {
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
}): Promise<{ pending: number }> {
  const pageSize = deps.pageSize ?? REDELIVER_PAGE_SIZE;
  let processed = 0;
  let after: { createdAt: string; id: string } | undefined;
  for (;;) {
    const page = await deps.reviews.listPendingBrainDreamReviews({
      appId: deps.appId,
      limit: pageSize,
      after,
    });
    if (page.length === 0) break;
    for (const review of page) {
      await deps.notify(review); // notifier never throws; outcome ignored (best-effort)
      processed += 1;
    }
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
    if (page.length < pageSize) break;
  }
  return { pending: processed };
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
  // True only when an outbound delivery was created/exists for the review key.
  // False on a missing verified owner or an enqueue failure (both warned).
  delivered: boolean;
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
        return { delivered: false, reason };
      }
      const { view, text } = buildBrainReviewNotification(review);
      await deps.gateway.enqueue({
        appId: deps.appId,
        conversationJid: owner.conversationJid,
        providerAccountId: owner.providerAccountId,
        threadId: null,
        idempotencyKey: brainReviewNotifyIdempotencyKey(review.id),
        text,
        brainReviewView: view,
      });
      return { delivered: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      safeWarn(
        { reviewId: review.id, error: reason },
        'brain review notification failed; will surface via the pending-review list',
      );
      return { delivered: false, reason };
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
