import { createHash } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { MessageAttachmentDeletionScope } from '../../../../domain/ports/message-attachment-repository.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import * as pgSchema from '../schema/schema.js';

export interface NormalizedMessageAttachmentDeletionScope
  extends MessageAttachmentDeletionScope {
  markerId: string;
  providerAccountIds: readonly string[];
  externalMessageIds: readonly string[];
}

export function normalizeMessageAttachmentDeletionScope(
  input: MessageAttachmentDeletionScope,
): NormalizedMessageAttachmentDeletionScope | undefined {
  const providerAccountIds = normalizedStrings(input.providerAccountIds);
  const externalMessageIds = normalizedStrings(input.externalMessageIds);
  const appId = input.appId.trim();
  const providerId = input.providerId.trim();
  const conversationJid = input.conversationJid.trim();
  const threadId = input.threadId?.trim() || undefined;
  if (
    !appId ||
    !providerId ||
    !conversationJid ||
    providerAccountIds.length === 0 ||
    externalMessageIds.length === 0
  ) {
    return undefined;
  }
  const identity = JSON.stringify([
    appId,
    providerId,
    providerAccountIds,
    conversationJid,
    threadId ?? null,
    externalMessageIds,
  ]);
  return {
    ...input,
    appId,
    providerId,
    providerAccountIds,
    conversationJid,
    ...(threadId ? { threadId } : {}),
    externalMessageIds,
    markerId: `message-attachment-deletion:${createHash('sha256').update(identity).digest('hex')}`,
  };
}

export async function persistMessageAttachmentDeletionMarker(
  tx: CanonicalExecutor,
  scope: NormalizedMessageAttachmentDeletionScope,
): Promise<void> {
  const marker = pgSchema.messageAttachmentDeletionMarkersPostgres;
  await tx
    .insert(marker)
    .values({
      id: scope.markerId,
      appId: scope.appId,
      providerId: scope.providerId,
      providerAccountIdsJson: scope.providerAccountIds,
      conversationJid: scope.conversationJid,
      threadId: scope.threadId ?? null,
      externalMessageIdsJson: scope.externalMessageIds,
      deletedAt: scope.deletedAt,
    })
    .onConflictDoUpdate({
      target: marker.id,
      set: {
        deletedAt: sql`least(${marker.deletedAt}, excluded.deleted_at)`,
      },
    });
}

export async function deletionMarkerTimestampForMessage(
  tx: CanonicalExecutor,
  input: {
    appId: string;
    providerId: string;
    providerAccountId: string;
    conversationJid: string;
    threadId?: string;
    externalMessageId?: string | null;
  },
): Promise<string | undefined> {
  if (!input.externalMessageId) return undefined;
  const marker = pgSchema.messageAttachmentDeletionMarkersPostgres;
  const externalMessageId = input.externalMessageId;
  const rows = await tx
    .select({
      id: marker.id,
      deletedAt: marker.deletedAt,
      externalMessageIds: marker.externalMessageIdsJson,
    })
    .from(marker)
    .where(
      and(
        eq(marker.appId, input.appId),
        eq(marker.providerId, input.providerId),
        eq(marker.conversationJid, input.conversationJid),
        input.threadId
          ? eq(marker.threadId, input.threadId)
          : isNull(marker.threadId),
        sql`${marker.providerAccountIdsJson} @> jsonb_build_array(${input.providerAccountId}::text)`,
        sql`${marker.externalMessageIdsJson} @> jsonb_build_array(${externalMessageId}::text)`,
      ),
    );
  if (rows.length === 0) return undefined;
  // Consume this message id from every matched marker inside the same
  // transaction as the insert that applies the tombstone; a marker whose id
  // set empties has fully served its purpose and is deleted.
  for (const row of rows) {
    const remaining = (
      Array.isArray(row.externalMessageIds) ? row.externalMessageIds : []
    ).filter((id) => id !== externalMessageId);
    if (remaining.length === 0) {
      await tx.delete(marker).where(eq(marker.id, row.id));
    } else {
      await tx
        .update(marker)
        .set({ externalMessageIdsJson: remaining })
        .where(eq(marker.id, row.id));
    }
  }
  return rows
    .map((row) => row.deletedAt)
    .sort()[0];
}

function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
