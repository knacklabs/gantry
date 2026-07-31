import { and, eq, isNull, sql } from 'drizzle-orm';

import type {
  AttachmentStorageClaimResult,
  AttachmentTombstoneResult,
  MessageAttachmentRepository,
  ProviderFetchIdentity,
  ResolvableMessageAttachment,
} from '../../../../domain/ports/message-attachment-repository.js';
import { isProviderAttachmentStorageRef } from '../../../../shared/provider-attachment-materialization.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { lockCanonicalMessageAttachments } from './canonical-message-attachment-lock.postgres.js';
import * as pgSchema from '../schema/schema.js';
import {
  cleanupRemovedProviderAttachments,
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
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
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
          .set({
            deletedAt: input.deletedAt,
            ...(providerStorageRef ? { storageRef: null } : {}),
          })
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
        await tx
          .update(attachment)
          .set({ storageRef: null })
          .where(
            and(
              eq(attachment.id, input.attachmentId),
              eq(attachment.messageId, owner[0].messageId),
              eq(attachment.storageRef, existing[0].storageRef),
            ),
          );
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
      await cleanupRemovedProviderAttachments(
        this.db,
        [
          {
            messageId: input.expectedMessageId,
            storageRef: result.storageRef,
          },
        ],
        this.cleanupProviderAttachment,
      );
    }
    return result;
  }
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
