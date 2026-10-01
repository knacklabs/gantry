import type { JobPermissionCardRecord } from './ports/job-permission-durability.js';

const MAX_RESUMED_RUN_BUDGETS = 20;
const MAX_ENQUEUED_RERUN_BARRIERS = 20;

// Keeps the latest revision, the one on screen, the one that opened the
// current message (its confirmation time decides edit vs replace), and every
// revision whose delivery is still open. A tap on any other revision is stale.
export function pruneSettledCardHistory(card: JobPermissionCardRecord): void {
  const kept = new Set([card.revision, card.currentProviderRevision]);
  const opening = new Set(
    card.revisions
      .filter(
        ({ operation }) => operation === 'send' || operation === 'replace',
      )
      .map(({ revision }) => revision),
  );
  const openedCurrentMessage = card.revisionDeliveries.find(
    (entry) =>
      entry.providerMessageId !== null &&
      entry.providerMessageId === card.currentProviderMessageId &&
      opening.has(entry.revision),
  );
  if (openedCurrentMessage) kept.add(openedCurrentMessage.revision);
  for (const entry of card.revisionDeliveries) {
    if (entry.status === 'pending' || entry.status === 'ambiguous') {
      kept.add(entry.revision);
    }
  }
  card.revisions = card.revisions.filter(({ revision }) => kept.has(revision));
  card.revisionDeliveries = card.revisionDeliveries.filter(({ revision }) =>
    kept.has(revision),
  );
  // A run's wait budget matters only while it waits (open) or, once resumed,
  // for the lease extension it earned. A budget that never waited holds
  // nothing a fresh one would not, so every run's heartbeat no longer adds a
  // permanent entry.
  // ponytail: resumed budgets are capped by count, not by run liveness; a
  // resumed run loses its extension only if 20 newer runs of the same job
  // waited while it was still running. Check run leases if that ever happens.
  const resumed = new Set(
    card.pendingBudgets
      .filter((budget) => budget.openCount === 0 && budget.accumulatedMs > 0)
      .slice(-MAX_RESUMED_RUN_BUDGETS),
  );
  card.pendingBudgets = card.pendingBudgets.filter(
    (budget) => budget.openCount > 0 || resumed.has(budget),
  );
  // A barrier not yet enqueued still gates its rerun. Once enqueued, the
  // rerun's stable trigger id (keyed by the prior run) is what keeps the
  // enqueue idempotent, so only the newest few are kept for re-consent.
  const enqueued = new Set(
    card.rerunBarriers
      .filter((barrier) => barrier.enqueuedAt)
      .slice(-MAX_ENQUEUED_RERUN_BARRIERS),
  );
  card.rerunBarriers = card.rerunBarriers.filter(
    (barrier) => !barrier.enqueuedAt || enqueued.has(barrier),
  );
}
