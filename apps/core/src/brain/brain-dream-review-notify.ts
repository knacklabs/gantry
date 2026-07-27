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

/**
 * Recovery pass for orphaned notifications: re-enqueue every pending review's
 * owner-DM notification. Best-effort delivery happens ONCE at intake; a transient
 * owner-resolve/enqueue failure leaves the review pending with no outbound record
 * and nothing re-notifies it. Re-enqueuing is safe to repeat — the enqueue is
 * idempotent on `brain-review:<reviewId>`, so a review that already has a durable
 * delivery is a no-op and an orphaned one gets a fresh record for the outbound
 * recovery loop to send. ponytail: no per-review outbound-existence probe — the
 * idempotency key IS the dedup; bounded because pending reviews are few.
 */
export async function redeliverPendingBrainReviews(deps: {
  reviews: {
    listPendingBrainDreamReviews(input: {
      appId: string;
      limit: number;
    }): Promise<NotifiableBrainReview[]>;
  };
  appId: string;
  notify: BrainReviewNotifier;
  limit?: number;
}): Promise<{ pending: number }> {
  const pending = await deps.reviews.listPendingBrainDreamReviews({
    appId: deps.appId,
    limit: deps.limit ?? 200,
  });
  for (const review of pending) await deps.notify(review); // notifier never throws
  return { pending: pending.length };
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

export type BrainReviewNotifier = (
  review: NotifiableBrainReview,
) => Promise<void>;

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
        safeWarn(
          { reviewId: review.id },
          'brain review not delivered: no verified owner route configured',
        );
        return;
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
    } catch (err) {
      safeWarn(
        {
          reviewId: review.id,
          error: err instanceof Error ? err.message : String(err),
        },
        'brain review notification failed; will surface via the pending-review list',
      );
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
