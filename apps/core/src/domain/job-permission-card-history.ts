import type { JobPermissionCardRecord } from './ports/job-permission-durability.js';

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
}
