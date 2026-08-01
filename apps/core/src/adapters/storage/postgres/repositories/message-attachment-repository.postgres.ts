import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type {
  AttachmentStorageClaimResult,
  AttachmentTombstoneResult,
  MessageAttachmentDeletionResult,
  MessageAttachmentDeletionScope,
  MessageAttachmentRepository,
  ProviderFetchIdentity,
  ResolvableMessageAttachment,
} from '../../../../domain/ports/message-attachment-repository.js';
import { isProviderAttachmentStorageRef } from '../../../../shared/provider-attachment-materialization.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { lockCanonicalMessageAttachments } from './canonical-message-attachment-lock.postgres.js';
import {
  admittedMessageAttachmentDeletionPairs,
  deletionPairFromMarker,
  normalizeMessageAttachmentDeletionScope,
  persistMessageAttachmentDeletionMarkers,
  retryActionableMessageAttachmentDeletionMarkers,
} from './message-attachment-deletion-markers.postgres.js';
import * as pgSchema from '../schema/schema.js';
import {
  cleanupRemovedProviderAttachments,
  reclaimTombstonedProviderAttachment,
  type ProviderAttachmentCleanup,
} from './provider-attachment-cleanup.postgres.js';

type MaterializedStorageClaim = Extract<
  AttachmentStorageClaimResult,
  { status: 'materialized' }
>;

type StorageClaimTransactionResult =
  | (MaterializedStorageClaim & { displacedStorageRef?: string })
  | Exclude<AttachmentStorageClaimResult, MaterializedStorageClaim>;

export class PostgresMessageAttachmentRepository implements MessageAttachmentRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly cleanupProviderAttachment: ProviderAttachmentCleanup = missingProviderAttachmentCleanup,
  ) {}

  async getResolvableAttachment(
    attachmentId: string,
  ): Promise<ResolvableMessageAttachment | null> {
    const attachment = pgSchema.messageAttachmentsPostgres;
    const message = pgSchema.messagesPostgres;
    const conversation = pgSchema.conversationsPostgres;
    const providerAccount = pgSchema.providerAccountsPostgres;
    const rows = await this.db
      .select({
        id: attachment.id,
        messageId: message.id,
        messageAppId: message.appId,
        conversationAppId: conversation.appId,
        providerAccountAppId: providerAccount.appId,
        conversationId: message.conversationId,
        conversationJid: sql<string>`${conversation.externalRefJson}::jsonb->>'jid'`,
        threadId: message.threadId,
        messageProviderAccountId: message.providerAccountId,
        conversationProviderAccountId: conversation.providerAccountId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        storageRef: attachment.storageRef,
        providerFetch: attachment.providerFetchJson,
        deletedAt: attachment.deletedAt,
      })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(
        providerAccount,
        and(
          eq(providerAccount.id, message.providerAccountId),
          eq(providerAccount.id, conversation.providerAccountId),
        ),
      )
      .where(eq(attachment.id, attachmentId))
      .limit(1);
    const row = rows[0];
    if (
      !row?.conversationJid ||
      row.messageProviderAccountId !== row.conversationProviderAccountId ||
      row.messageAppId !== row.conversationAppId ||
      row.providerAccountAppId !== row.conversationAppId
    ) {
      return null;
    }
    const providerFetch = parseProviderFetch(row.providerFetch);
    return {
      id: row.id,
      messageId: row.messageId,
      appId: row.conversationAppId,
      conversationId: row.conversationId as never,
      conversationJid: row.conversationJid,
      ...(row.threadId ? { threadId: row.threadId as never } : {}),
      providerAccountId: row.conversationProviderAccountId,
      ...(row.fileName ? { fileName: row.fileName } : {}),
      ...(row.contentType ? { contentType: row.contentType } : {}),
      ...(row.sizeBytes !== null ? { sizeBytes: row.sizeBytes } : {}),
      ...(row.storageRef ? { storageRef: row.storageRef } : {}),
      ...(providerFetch ? { providerFetch } : {}),
      ...(row.deletedAt ? { deletedAt: toIsoTimestamp(row.deletedAt) } : {}),
    };
  }

  async setStorageRefIfAbsent(input: {
    attachmentId: string;
    expectedMessageId: string;
    expectedAppId: string;
    expectedConversationId: ResolvableMessageAttachment['conversationId'];
    expectedProviderAccountId: string;
    expectedProviderFetch: ProviderFetchIdentity;
    expectedStorageRef?: string;
    storageRef: string;
    fileName?: string;
    contentType?: string;
    sizeBytes?: number;
  }): Promise<AttachmentStorageClaimResult> {
    const attachment = pgSchema.messageAttachmentsPostgres;
    const message = pgSchema.messagesPostgres;
    const result = await this.db.transaction(
      async (tx): Promise<StorageClaimTransactionResult> => {
        const observed = await tx
          .select({ messageId: attachment.messageId })
          .from(attachment)
          .where(eq(attachment.id, input.attachmentId))
          .limit(1);
        if (observed[0]?.messageId !== input.expectedMessageId) {
          return { status: 'missing' };
        }
        await lockCanonicalMessageAttachments(tx, observed[0].messageId);
        const owner = await tx
          .select({
            messageId: attachment.messageId,
            appId: message.appId,
            conversationId: message.conversationId,
            providerAccountId: message.providerAccountId,
            providerFetch: attachment.providerFetchJson,
            storageRef: attachment.storageRef,
          })
          .from(attachment)
          .innerJoin(message, eq(message.id, attachment.messageId))
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, input.expectedMessageId),
            ),
          )
          .limit(1);
        if (
          !owner[0] ||
          owner[0].messageId !== input.expectedMessageId ||
          owner[0].appId !== input.expectedAppId ||
          owner[0].conversationId !== input.expectedConversationId ||
          owner[0].providerAccountId !== input.expectedProviderAccountId
        ) {
          return { status: 'missing' };
        }
        if (
          !sameProviderFetchIdentity(
            owner[0].providerFetch,
            input.expectedProviderFetch,
          )
        ) {
          return { status: 'stale' };
        }
        const updated = await tx
          .update(attachment)
          .set({
            storageRef: input.storageRef,
            ...(input.fileName ? { fileName: input.fileName } : {}),
            ...(input.contentType ? { contentType: input.contentType } : {}),
            ...(input.sizeBytes !== undefined
              ? { sizeBytes: input.sizeBytes }
              : {}),
          })
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, owner[0].messageId),
              input.expectedStorageRef !== undefined
                ? eq(attachment.storageRef, input.expectedStorageRef)
                : isNull(attachment.storageRef),
              providerFetchIdentityCondition(
                attachment,
                input.expectedProviderFetch,
              ),
              isNull(attachment.deletedAt),
            ),
          )
          .returning({
            storageRef: attachment.storageRef,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
          });
        const updatedAttachment = updated[0];
        if (updatedAttachment?.storageRef) {
          const displacedStorageRef =
            owner[0].storageRef &&
            owner[0].storageRef !== updatedAttachment.storageRef &&
            isProviderAttachmentStorageRef(owner[0].storageRef)
              ? owner[0].storageRef
              : undefined;
          return {
            status: 'materialized' as const,
            attachment: materializedAttachment({
              ...updatedAttachment,
              storageRef: updatedAttachment.storageRef,
            }),
            ...(displacedStorageRef ? { displacedStorageRef } : {}),
          };
        }
        const existing = await tx
          .select({
            storageRef: attachment.storageRef,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
            deletedAt: attachment.deletedAt,
            providerFetch: attachment.providerFetchJson,
          })
          .from(attachment)
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, owner[0].messageId),
            ),
          )
          .limit(1);
        const existingAttachment = existing[0];
        if (
          existingAttachment &&
          !sameProviderFetchIdentity(
            existingAttachment.providerFetch,
            input.expectedProviderFetch,
          )
        ) {
          return { status: 'stale' };
        }
        if (existingAttachment?.deletedAt) return { status: 'deleted' };
        if (!existingAttachment?.storageRef) return { status: 'missing' };
        return {
          status: 'materialized',
          attachment: materializedAttachment({
            ...existingAttachment,
            storageRef: existingAttachment.storageRef,
          }),
        };
      },
    );
    if (result.status !== 'materialized') return result;
    if (result.displacedStorageRef) {
      await cleanupRemovedProviderAttachments(
        this.db,
        [
          {
            messageId: input.expectedMessageId,
            storageRef: result.displacedStorageRef,
          },
        ],
        this.cleanupProviderAttachment,
      );
    }
    const { displacedStorageRef: _displacedStorageRef, ...claim } = result;
    return claim;
  }

  async setDeletedAt(input: {
    attachmentId: string;
    expectedMessageId: string;
    expectedAppId: string;
    expectedConversationId: ResolvableMessageAttachment['conversationId'];
    expectedProviderAccountId: string;
    expectedProviderFetch: ProviderFetchIdentity;
    deletedAt: string;
  }): Promise<AttachmentTombstoneResult> {
    const attachment = pgSchema.messageAttachmentsPostgres;
    const message = pgSchema.messagesPostgres;
    const result: AttachmentTombstoneResult = await this.db.transaction(
      async (tx) => {
        const observed = await tx
          .select({ messageId: attachment.messageId })
          .from(attachment)
          .where(eq(attachment.id, input.attachmentId))
          .limit(1);
        if (observed[0]?.messageId !== input.expectedMessageId) {
          return { tombstoned: false };
        }
        await lockCanonicalMessageAttachments(tx, observed[0].messageId);
        const owner = await tx
          .select({
            messageId: attachment.messageId,
            appId: message.appId,
            conversationId: message.conversationId,
            providerAccountId: message.providerAccountId,
            providerFetch: attachment.providerFetchJson,
            storageRef: attachment.storageRef,
          })
          .from(attachment)
          .innerJoin(message, eq(message.id, attachment.messageId))
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, input.expectedMessageId),
            ),
          )
          .limit(1);
        if (
          !owner[0] ||
          owner[0].messageId !== input.expectedMessageId ||
          owner[0].appId !== input.expectedAppId ||
          owner[0].conversationId !== input.expectedConversationId ||
          owner[0].providerAccountId !== input.expectedProviderAccountId
        ) {
          return { tombstoned: false };
        }
        if (
          !sameProviderFetchIdentity(
            owner[0].providerFetch,
            input.expectedProviderFetch,
          )
        ) {
          return { tombstoned: false, stale: true };
        }
        const providerStorageRef =
          owner[0].storageRef &&
          isProviderAttachmentStorageRef(owner[0].storageRef)
            ? owner[0].storageRef
            : undefined;
        const rows = await tx
          .update(attachment)
          .set({ deletedAt: input.deletedAt })
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, owner[0].messageId),
              providerFetchIdentityCondition(
                attachment,
                input.expectedProviderFetch,
              ),
              isNull(attachment.deletedAt),
            ),
          )
          .returning({ id: attachment.id });
        if (rows[0]) {
          return {
            tombstoned: true,
            ...(providerStorageRef ? { storageRef: providerStorageRef } : {}),
          };
        }
        const existing = await tx
          .select({
            deletedAt: attachment.deletedAt,
            storageRef: attachment.storageRef,
            providerFetch: attachment.providerFetchJson,
          })
          .from(attachment)
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, owner[0].messageId),
            ),
          )
          .limit(1);
        if (
          existing[0] &&
          !sameProviderFetchIdentity(
            existing[0].providerFetch,
            input.expectedProviderFetch,
          )
        ) {
          return { tombstoned: false, stale: true };
        }
        if (!existing[0]?.deletedAt) return { tombstoned: false };
        if (
          !existing[0].storageRef ||
          !isProviderAttachmentStorageRef(existing[0].storageRef)
        ) {
          return { tombstoned: true };
        }
        return {
          tombstoned: true,
          storageRef: existing[0].storageRef,
        };
      },
    );
    if (
      result.tombstoned &&
      result.storageRef &&
      isProviderAttachmentStorageRef(result.storageRef)
    ) {
      await this.reclaimTombstonedStorageRef({
        attachmentId: input.attachmentId,
        messageId: input.expectedMessageId,
        storageRef: result.storageRef,
      });
    }
    return result;
  }

  async setDeletedAtByMessageExternalIds(
    input: MessageAttachmentDeletionScope,
  ): Promise<MessageAttachmentDeletionResult> {
    const normalizedPairs = normalizeMessageAttachmentDeletionScope(input);
    if (normalizedPairs.length === 0) {
      return { tombstonedAttachments: [] };
    }
    const pairs = await this.db.transaction(async (tx) => {
      const admitted = await admittedMessageAttachmentDeletionPairs(tx, input);
      await persistMessageAttachmentDeletionMarkers(tx, admitted);
      return admitted;
    });
    const results = [];
    for (const pair of pairs) {
      results.push(await this.processDeletionMarker(pair.markerId));
    }
    return {
      tombstonedAttachments: results
        .flatMap((result) => result.tombstonedAttachments)
        .sort((a, b) => a.attachmentId.localeCompare(b.attachmentId)),
    };
  }

  async retryPendingMessageAttachmentDeletions(): Promise<boolean> {
    return retryActionableMessageAttachmentDeletionMarkers(
      this.db,
      (markerId) => this.processDeletionMarker(markerId),
    );
  }

  private async processDeletionMarker(
    markerId: string,
  ): Promise<MessageAttachmentDeletionResult> {
    const marker = pgSchema.messageAttachmentDeletionMarkersPostgres;

    const attachment = pgSchema.messageAttachmentsPostgres;
    const message = pgSchema.messagesPostgres;
    const conversation = pgSchema.conversationsPostgres;
    const providerAccount = pgSchema.providerAccountsPostgres;
    const result = await this.db.transaction(async (tx) => {
      const markerRows = await tx
        .select()
        .from(marker)
        .where(eq(marker.id, markerId))
        .limit(1)
        .for('update');
      const pair = deletionPairFromMarker(markerRows[0]);
      if (!pair) {
        return {
          rows: [],
          tombstonedAttachments: [],
          matched: false,
          providerId: '',
        };
      }
      const scopeCondition = and(
        eq(message.appId, pair.appId),
        eq(conversation.appId, pair.appId),
        eq(providerAccount.appId, pair.appId),
        eq(message.providerId, pair.providerId),
        eq(providerAccount.providerId, pair.providerId),
        eq(message.providerAccountId, pair.providerAccountId),
        eq(conversation.providerAccountId, message.providerAccountId),
        eq(message.externalMessageId, pair.externalMessageId),
        or(
          and(
            isNull(message.threadId),
            eq(
              sql<string>`${conversation.externalRefJson}::jsonb->>'jid'`,
              pair.channelId,
            ),
          ),
          eq(
            sql<string>`${message.externalRefJson}::jsonb->>'thread_id'`,
            pair.channelId,
          ),
        ),
      );
      const candidates = await tx
        .select({ messageId: message.id })
        .from(message)
        .innerJoin(conversation, eq(conversation.id, message.conversationId))
        .innerJoin(
          providerAccount,
          eq(providerAccount.id, message.providerAccountId),
        )
        .where(scopeCondition)
        .orderBy(asc(message.id));
      const messageIds = [...new Set(candidates.map((row) => row.messageId))];
      for (const messageId of messageIds) {
        await lockCanonicalMessageAttachments(tx, messageId);
      }
      if (messageIds.length === 0) {
        return {
          rows: [],
          tombstonedAttachments: [],
          matched: false,
          providerId: '',
        };
      }

      const owned = await tx
        .select({
          id: attachment.id,
          messageId: attachment.messageId,
          deletedAt: attachment.deletedAt,
          storageRef: attachment.storageRef,
        })
        .from(attachment)
        .innerJoin(message, eq(message.id, attachment.messageId))
        .innerJoin(conversation, eq(conversation.id, message.conversationId))
        .innerJoin(
          providerAccount,
          eq(providerAccount.id, message.providerAccountId),
        )
        .where(
          and(
            scopeCondition,
            inArray(message.id, messageIds),
            deletionProviderOwnershipCondition(attachment, pair.providerId),
          ),
        )
        .orderBy(asc(message.id), asc(attachment.id));
      const ownedIds = owned.map((row) => row.id);
      const updatedDeletedAtById = new Map<string, string>();
      if (ownedIds.length > 0) {
        const updated = await tx
          .update(attachment)
          .set({
            deletedAt: sql`least(${attachment.deletedAt}, ${pair.deletedAt})`,
          })
          .where(
            and(
              inArray(attachment.id, ownedIds),
              deletionProviderOwnershipCondition(attachment, pair.providerId),
            ),
          )
          .returning({ id: attachment.id, deletedAt: attachment.deletedAt });
        for (const row of updated) {
          if (row.deletedAt) {
            updatedDeletedAtById.set(row.id, toIsoTimestamp(row.deletedAt));
          }
        }
      }
      return {
        rows: owned,
        tombstonedAttachments: owned.flatMap((row) => {
          const deletedAt =
            updatedDeletedAtById.get(row.id) ??
            (row.deletedAt ? toIsoTimestamp(row.deletedAt) : undefined);
          return deletedAt ? [{ attachmentId: row.id, deletedAt }] : [];
        }),
        // Consume only when attachment rows were actually seen: a matched
        // message with zero rows may still be awaiting capture or backfill,
        // and the insert-side consumption owns that hand-off.
        matched: owned.length > 0,
        providerId: pair.providerId,
        candidateMessageIds: messageIds,
      };
    });

    for (const row of result.rows) {
      if (!row.storageRef || !isProviderAttachmentStorageRef(row.storageRef)) {
        continue;
      }
      await this.reclaimTombstonedStorageRef({
        attachmentId: row.id,
        messageId: row.messageId,
        storageRef: row.storageRef,
      });
    }
    if (result.matched) {
      // Final consumption is scope-verified under the message locks: any
      // provider-backed ref that appeared concurrently (redelivery, backfill)
      // keeps the marker alive for the retry sweep instead of being stranded.
      await this.db.transaction(async (tx) => {
        // Same lock order as the tombstoning transaction (marker row first,
        // then message attachment locks) so concurrent processing of the same
        // marker cannot deadlock.
        await tx
          .select({ id: marker.id })
          .from(marker)
          .where(eq(marker.id, markerId))
          .limit(1)
          .for('update');
        const messageIds = [
          ...new Set([
            ...(result.candidateMessageIds ?? []),
            ...result.rows.map((row) => row.messageId),
          ]),
        ].sort();
        for (const messageId of messageIds) {
          await lockCanonicalMessageAttachments(tx, messageId);
        }
        const scoped = messageIds.length
          ? await tx
              .select({ storageRef: attachment.storageRef })
              .from(attachment)
              .where(
                and(
                  inArray(attachment.messageId, messageIds),
                  deletionProviderOwnershipCondition(
                    attachment,
                    result.providerId,
                  ),
                ),
              )
          : [];
        if (
          scoped.some(
            (row) =>
              row.storageRef && isProviderAttachmentStorageRef(row.storageRef),
          )
        ) {
          throw new Error(
            'Tombstoned provider attachment cleanup remains pending',
          );
        }
        await tx.delete(marker).where(eq(marker.id, markerId));
      });
    }
    return {
      tombstonedAttachments: [...result.tombstonedAttachments].sort((a, b) =>
        a.attachmentId.localeCompare(b.attachmentId),
      ),
    };
  }

  async reclaimTombstonedStorageRef(input: {
    attachmentId: string;
    messageId: string;
    storageRef: string;
  }): Promise<void> {
    await reclaimTombstonedProviderAttachment(
      this.db,
      input,
      this.cleanupProviderAttachment,
    );
  }
}

function deletionProviderOwnershipCondition(
  attachment: typeof pgSchema.messageAttachmentsPostgres,
  providerId: string,
) {
  const providerKey = sql<string>`${attachment.providerFetchJson}::jsonb->>'provider'`;
  return or(
    isNull(attachment.providerFetchJson),
    isNull(providerKey),
    eq(providerKey, providerId),
  );
}

function toIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function providerFetchIdentityCondition(
  attachment: typeof pgSchema.messageAttachmentsPostgres,
  expected: ProviderFetchIdentity,
) {
  return sql<boolean>`(
    ${attachment.providerFetchJson}->>'provider' = ${expected.provider}
    AND ${attachment.providerFetchJson}->>'kind' = ${expected.kind}
    AND ${attachment.providerFetchJson}->>'id' = ${expected.id}
  )`;
}

function sameProviderFetchIdentity(
  value: unknown,
  expected: ProviderFetchIdentity,
): boolean {
  const current = parseProviderFetch(value);
  return (
    current?.provider === expected.provider &&
    current.kind === expected.kind &&
    current.id === expected.id
  );
}

function materializedAttachment(row: {
  storageRef: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
}) {
  return {
    storageRef: row.storageRef,
    ...(row.fileName ? { fileName: row.fileName } : {}),
    ...(row.contentType ? { contentType: row.contentType } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: row.sizeBytes } : {}),
  };
}

function parseProviderFetch(
  value: unknown,
): ResolvableMessageAttachment['providerFetch'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.provider !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.id !== 'string'
  ) {
    return undefined;
  }
  return {
    ...record,
    provider: record.provider,
    kind: record.kind,
    id: record.id,
  };
}

async function missingProviderAttachmentCleanup(): Promise<never> {
  throw new Error('Provider attachment cleanup dependency is not configured');
}
