import { createHash } from 'node:crypto';

import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import type { MessageAttachmentDeletionScope } from '../../../../domain/ports/message-attachment-repository.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import * as pgSchema from '../schema/schema.js';

export interface NormalizedMessageAttachmentDeletionPair {
  markerId: string;
  appId: string;
  providerId: string;
  providerAccountId: string;
  channelId: string;
  externalMessageId: string;
  deletedAt: string;
}

export function normalizeMessageAttachmentDeletionScope(
  input: MessageAttachmentDeletionScope,
): NormalizedMessageAttachmentDeletionPair[] {
  const providerAccountIds = normalizedStrings(input.providerAccountIds);
  const externalMessageIds = normalizedStrings(input.externalMessageIds);
  const appId = input.appId.trim();
  const providerId = input.providerId.trim();
  const channelId = input.channelId.trim();
  if (
    !appId ||
    !providerId ||
    !channelId ||
    providerAccountIds.length === 0 ||
    externalMessageIds.length === 0
  ) {
    return [];
  }
  return providerAccountIds.flatMap((providerAccountId) =>
    externalMessageIds.map((externalMessageId) => {
      return {
        markerId: deletionMarkerId({
          appId,
          providerId,
          providerAccountId,
          channelId,
          externalMessageId,
        }),
        appId,
        providerId,
        providerAccountId,
        channelId,
        externalMessageId,
        deletedAt: input.deletedAt,
      };
    }),
  );
}

export async function persistMessageAttachmentDeletionMarkers(
  tx: CanonicalExecutor,
  pairs: readonly NormalizedMessageAttachmentDeletionPair[],
): Promise<void> {
  if (pairs.length === 0) return;
  const marker = pgSchema.messageAttachmentDeletionMarkersPostgres;
  await tx
    .insert(marker)
    .values(
      pairs.map((pair) => ({
        id: pair.markerId,
        appId: pair.appId,
        providerId: pair.providerId,
        providerAccountId: pair.providerAccountId,
        channelId: pair.channelId,
        externalMessageId: pair.externalMessageId,
        deletedAt: pair.deletedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [
        marker.appId,
        marker.providerId,
        marker.providerAccountId,
        marker.channelId,
        marker.externalMessageId,
      ],
      set: {
        deletedAt: sql`least(${marker.deletedAt}, excluded.deleted_at)`,
      },
    });
}

export async function admittedMessageAttachmentDeletionPairs(
  tx: CanonicalExecutor,
  input: MessageAttachmentDeletionScope,
): Promise<NormalizedMessageAttachmentDeletionPair[]> {
  const pairs = normalizeMessageAttachmentDeletionScope(input);
  if (!input.requireStoredMessageMatch || pairs.length === 0) return pairs;

  const fallbackConversationJid = input.fallbackConversationJid?.trim();
  const message = pgSchema.messagesPostgres;
  const matched = await tx
    .select({
      providerAccountId: message.providerAccountId,
      externalMessageId: message.externalMessageId,
      threadId: sql<
        string | null
      >`${message.externalRefJson}::jsonb->>'thread_id'`,
      conversationJid: sql<
        string | null
      >`${message.externalRefJson}::jsonb->>'chat_jid'`,
    })
    .from(message)
    .where(
      and(
        eq(message.appId, input.appId.trim()),
        eq(message.providerId, input.providerId.trim()),
        inArray(
          message.providerAccountId,
          normalizedStrings(input.providerAccountIds),
        ),
        inArray(
          message.externalMessageId,
          normalizedStrings(input.externalMessageIds),
        ),
        or(
          eq(
            sql<string>`${message.externalRefJson}::jsonb->>'thread_id'`,
            input.channelId.trim(),
          ),
          ...(fallbackConversationJid
            ? [
                and(
                  isNull(message.threadId),
                  eq(
                    sql<string>`${message.externalRefJson}::jsonb->>'chat_jid'`,
                    fallbackConversationJid,
                  ),
                ),
              ]
            : []),
        ),
      ),
    );
  // A stored match proves the (channel, account) scope: every event id for an
  // admitted account persists (the in-flight sibling is the ingest race this
  // mechanism exists for). Each pair's channel comes from ITS OWN stored
  // match; ids without one inherit the raw event channel key — never another
  // pair's mapping.
  const channelIdByPair = new Map<string, string>();
  // Per-account default for siblings without their own stored match: the raw
  // event channel when a thread match proved it IS a thread, otherwise the
  // admitted conversation JID mapping — a raw key that ingestion will never
  // look up must not leak onto sibling markers.
  const defaultChannelByAccount = new Map<string, string>();
  for (const row of matched) {
    const isThreadMatch = row.threadId === input.channelId.trim();
    const admittedChannelId = isThreadMatch
      ? input.channelId.trim()
      : (row.conversationJid ?? fallbackConversationJid);
    if (!admittedChannelId) continue;
    const key = `${row.providerAccountId}\u0000${row.externalMessageId ?? ''}`;
    const existing = channelIdByPair.get(key);
    if (!existing || isThreadMatch) {
      channelIdByPair.set(key, admittedChannelId);
    }
    const existingDefault = defaultChannelByAccount.get(row.providerAccountId);
    if (!existingDefault || isThreadMatch) {
      defaultChannelByAccount.set(row.providerAccountId, admittedChannelId);
    }
  }
  return pairs.flatMap((pair) => {
    const channelId =
      channelIdByPair.get(
        `${pair.providerAccountId}\u0000${pair.externalMessageId}`,
      ) ?? defaultChannelByAccount.get(pair.providerAccountId);
    if (!channelId) return [];
    return [
      {
        ...pair,
        channelId,
        markerId: deletionMarkerId({ ...pair, channelId }),
      },
    ];
  });
}

function deletionMarkerId(
  pair: Pick<
    NormalizedMessageAttachmentDeletionPair,
    | 'appId'
    | 'providerId'
    | 'providerAccountId'
    | 'channelId'
    | 'externalMessageId'
  >,
): string {
  const identity = JSON.stringify([
    pair.appId,
    pair.providerId,
    pair.providerAccountId,
    pair.channelId,
    pair.externalMessageId,
  ]);
  return `message-attachment-deletion:${createHash('sha256').update(identity).digest('hex')}`;
}

export async function retryActionableMessageAttachmentDeletionMarkers(
  db: CanonicalDb,
  processMarker: (markerId: string) => Promise<unknown>,
): Promise<boolean> {
  const marker = pgSchema.messageAttachmentDeletionMarkersPostgres;
  const message = pgSchema.messagesPostgres;
  const conversation = pgSchema.conversationsPostgres;
  let firstError: unknown;
  let cursor: { createdAt: string; id: string } | undefined;
  while (true) {
    const pending = await db
      .select({ id: marker.id, createdAt: marker.createdAt })
      .from(marker)
      .innerJoin(
        message,
        and(
          eq(message.appId, marker.appId),
          eq(message.providerId, marker.providerId),
          eq(message.providerAccountId, marker.providerAccountId),
          eq(message.externalMessageId, marker.externalMessageId),
        ),
      )
      .innerJoin(
        conversation,
        and(
          eq(conversation.id, message.conversationId),
          eq(conversation.appId, marker.appId),
          eq(conversation.providerAccountId, marker.providerAccountId),
          or(
            and(
              isNull(message.threadId),
              eq(
                sql<string>`${conversation.externalRefJson}::jsonb->>'jid'`,
                marker.channelId,
              ),
            ),
            eq(
              sql<string>`${message.externalRefJson}::jsonb->>'thread_id'`,
              marker.channelId,
            ),
          ),
        ),
      )
      .where(
        cursor
          ? or(
              gt(marker.createdAt, cursor.createdAt),
              and(
                eq(marker.createdAt, cursor.createdAt),
                gt(marker.id, cursor.id),
              ),
            )
          : undefined,
      )
      .orderBy(asc(marker.createdAt), asc(marker.id))
      .limit(100);
    for (const row of pending) {
      try {
        await processMarker(row.id);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (pending.length < 100) break;
    cursor = pending[pending.length - 1];
  }
  if (firstError) throw firstError;
  return false;
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
    canonicalMessageId: string;
    incomingHasProviderRefs?: boolean;
  },
): Promise<{ deletedAt: string; providerId: string } | undefined> {
  if (!input.externalMessageId) return undefined;
  const marker = pgSchema.messageAttachmentDeletionMarkersPostgres;
  const channelId = input.threadId ?? input.conversationJid.trim();
  if (!channelId) return undefined;
  const scopeCondition = and(
    eq(marker.appId, input.appId),
    eq(marker.providerId, input.providerId),
    eq(marker.providerAccountId, input.providerAccountId),
    eq(marker.channelId, channelId),
    eq(marker.externalMessageId, input.externalMessageId),
  );
  // Lock the marker rows (marker-before-attachment order, matching the
  // processing path) so final consumption cannot slip between this read and
  // the tombstoned insert that follows it. Raw execute keeps the SQL shape
  // compatible with the unit fakes, same as lockCanonicalMessageAttachments.
  await tx.execute(
    sql`select ${marker.id} from ${marker} where ${scopeCondition} for update`,
  );
  const rows = await tx
    .select({ deletedAt: marker.deletedAt })
    .from(marker)
    .where(scopeCondition);
  if (rows.length === 0) return undefined;
  // Consume the marker here only when this message has no provider-backed
  // materialization awaiting reclamation; otherwise leave it for the retry
  // sweep, whose processing path verifies cleanup before consuming.
  const attachment = pgSchema.messageAttachmentsPostgres;
  const pendingRefs = await tx
    .select({ id: attachment.id, storageRef: attachment.storageRef })
    .from(attachment)
    .where(eq(attachment.messageId, input.canonicalMessageId));
  const hasProviderRef =
    input.incomingHasProviderRefs === true ||
    pendingRefs.some(
      (row) =>
        typeof row.storageRef === 'string' &&
        row.storageRef.startsWith('provider-attachments/'),
    );
  if (!hasProviderRef) {
    await tx.delete(marker).where(scopeCondition);
  }
  const deletedAt = rows.map((row) => row.deletedAt).sort()[0];
  return deletedAt !== undefined
    ? { deletedAt, providerId: input.providerId }
    : undefined;
}

export function deletionPairFromMarker(
  row:
    | typeof pgSchema.messageAttachmentDeletionMarkersPostgres.$inferSelect
    | undefined,
): NormalizedMessageAttachmentDeletionPair | undefined {
  if (!row) return undefined;
  return {
    markerId: row.id,
    appId: row.appId,
    providerId: row.providerId,
    providerAccountId: row.providerAccountId,
    channelId: row.channelId,
    externalMessageId: row.externalMessageId,
    deletedAt: row.deletedAt,
  };
}

function normalizedStrings(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}
