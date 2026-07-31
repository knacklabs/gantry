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
