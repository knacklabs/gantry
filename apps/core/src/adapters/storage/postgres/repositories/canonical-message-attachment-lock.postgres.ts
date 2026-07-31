import { sql } from 'drizzle-orm';

import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

export function canonicalMessageAttachmentLockKey(messageId: string): string {
  return `canonical_message_attachments:${messageId}`;
}

export async function lockCanonicalMessageAttachments(
  executor: CanonicalExecutor,
  messageId: string,
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${canonicalMessageAttachmentLockKey(messageId)}, 0))`,
  );
}

export function providerAttachmentStorageRefLockKey(
  storageRef: string,
): string {
  return `provider_attachment_storage_ref:${storageRef}`;
}

/** Serializes reclamation of ONE storage ref across messages: two rows in
 *  different messages can share a ref, and message-scoped locks alone allow
 *  a write-skew where each reclaim sees the other row, skips the unlink,
 *  and clears its own ref — stranding the file with no retry row. Always
 *  acquired AFTER the message lock; only cleanup paths take it, so the
 *  ordering is acyclic. */
export async function lockProviderAttachmentStorageRef(
  executor: CanonicalExecutor,
  storageRef: string,
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${providerAttachmentStorageRefLockKey(storageRef)}, 0))`,
  );
}
