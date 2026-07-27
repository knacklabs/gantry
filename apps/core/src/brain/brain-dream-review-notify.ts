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

// ponytail: a generous backstop, not the terminating mechanism. Orphans are rare
// (they arise only from a transient initial enqueue/owner-resolve failure); a
// huge orphan set signals a systemic enqueue outage, not normal operation.
const ORPHAN_PAGE_SIZE = 200;

/**
 * Recovery pass for ORPHANED notifications only: re-enqueue the owner-DM
 * notification for pending reviews that have NO durable outbound delivery for
 * their `brain-review:<id>` key. Best-effort delivery happens ONCE at intake; a
 * transient owner-resolve/enqueue failure leaves the review an orphan and nothing
 * re-notifies it. Re-enqueuing is idempotent, and a SUCCESSFUL re-enqueue creates
 * the delivery row — so that review drops out of the orphan query immediately. The
 * set therefore shrinks strictly as it drains: no per-pass cap and no persistent
 * cursor needed, and an already-delivered backlog is never re-scanned (the query
 * excludes it). A `seen` guard stops the drain if delivery keeps failing (e.g. no
 * verified owner) so a stuck orphan can't loop forever.
 */
export async function redeliverPendingBrainReviews(deps: {
  reviews: {
    listPendingBrainReviewsWithoutDelivery(input: {
      appId: string;
      limit: number;
    }): Promise<NotifiableBrainReview[]>;
  };
  appId: string;
  notify: BrainReviewNotifier;
  pageSize?: number;
}): Promise<{ delivered: number }> {
  const pageSize = deps.pageSize ?? ORPHAN_PAGE_SIZE;
  const seen = new Set<string>();
  let delivered = 0;
  for (;;) {
    const orphans = await deps.reviews.listPendingBrainReviewsWithoutDelivery({
      appId: deps.appId,
      limit: pageSize,
    });
    // Only rows we haven't attempted this pass. If none are new, every remaining
    // orphan failed delivery — stop instead of re-attempting the same set.
    const fresh = orphans.filter((review) => !seen.has(review.id));
    if (fresh.length === 0) break;
    for (const review of fresh) {
      seen.add(review.id);
      const outcome = await deps.notify(review); // never throws
      if (outcome.delivered) delivered += 1;
    }
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
