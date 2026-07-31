import { eq } from 'drizzle-orm';

import { logger } from '../../../../infrastructure/logging/logger.js';
import { isProviderAttachmentStorageRef } from '../../../../shared/provider-attachment-materialization.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { lockCanonicalMessageAttachments } from './canonical-message-attachment-lock.postgres.js';

export type ProviderAttachmentCleanup = (storageRef: string) => Promise<void>;

/*
 * Provider-materialization invariants:
 * 1. Only the resolver mints provider refs through its identity-bound CAS.
 *    Writers may carry forward only the matched row's current provider ref;
 *    every other incoming provider ref is dropped while fetch identity stays.
 * 2. Every non-empty displaced-ref set is handed off after commit to the
 *    reference-aware cleanup below (advisory lock plus zero-reference recheck).
 * 3. A provider ref whose file is missing self-heals on open from fetch identity.
 */

export interface RemovedProviderAttachment {
  messageId: string;
  storageRef: string;
}

export function storageRefForAttachmentWriter(
  incomingStorageRef: string | null | undefined,
  matchedCurrentStorageRef: string | null | undefined,
): string | null {
  if (
    incomingStorageRef &&
    isProviderAttachmentStorageRef(incomingStorageRef)
  ) {
    return incomingStorageRef === matchedCurrentStorageRef
      ? incomingStorageRef
      : (matchedCurrentStorageRef ?? null);
  }
  return incomingStorageRef ?? matchedCurrentStorageRef ?? null;
}

export async function cleanupRemovedProviderAttachments(
  db: CanonicalDb,
  removedAttachments: readonly RemovedProviderAttachment[],
  cleanupProviderAttachment: ProviderAttachmentCleanup,
): Promise<void> {
  if (removedAttachments.length === 0) return;
  await Promise.all(
    removedAttachments.map(async ({ messageId, storageRef }) => {
      try {
        await db.transaction(async (tx) => {
          await lockCanonicalMessageAttachments(tx, messageId);
          const referenced = await tx
            .select({ id: pgSchema.messageAttachmentsPostgres.id })
            .from(pgSchema.messageAttachmentsPostgres)
            .where(
              eq(pgSchema.messageAttachmentsPostgres.storageRef, storageRef),
            )
            .limit(1);
          if (referenced.length === 0) {
            await cleanupProviderAttachment(storageRef);
          }
        });
      } catch (error) {
        logger.warn(
          { errorCode: errorCode(error) },
          'Failed to clean removed provider attachment materialization',
        );
      }
    }),
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? String((error as { code?: unknown }).code ?? '') || undefined
    : undefined;
}
