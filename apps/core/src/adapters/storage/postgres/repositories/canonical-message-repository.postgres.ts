import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../../../domain/ports/live-turns.js';
import { agentIdForFolder as normalizeAgentIdForFolder } from '../../../../domain/agent/agent-folder-id.js';
import { normalizeProviderId } from '../../../../channels/provider-registry.js';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../../../shared/message-cursor.js';
import { makeThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import * as pgSchema from '../schema/schema.js';
import { enqueueLiveAdmissionWorkItem } from './live-admission-work-item-repository.postgres.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  conversationIdForJid,
  jsonb,
  PostgresCanonicalGraphRepository,
  providerIdForJid,
  threadIdFor,
} from './canonical-graph-repository.postgres.js';

export interface CanonicalOpsMessageRow {
  id: string;
  conversation_id: string;
  thread_id: string | null;
  external_ref_json: string | null;
  direction: string;
  sender_user_id: string | null;
  sender_display_name: string | null;
  trust: string;
  created_at: string;
  received_at: string | null;
  delivery_status: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  payload_json: string | null;
}

export interface MessageLiveAdmissionInput {
  appId: string;
  agentId?: string | null;
  agentSessionId?: string | null;
  triggerDecision?: Record<string, unknown>;
  now?: string;
}

export function messageIdFor(chatJid: string, id: string): string {
  return `message:${chatJid}:${id}`;
}

function liveAdmissionWorkItemId(appId: string, canonicalMessageId: string) {
  return `live-admission:${appId}:${canonicalMessageId}`;
}

function liveAdmissionIdempotencyKey(
  msg: NewMessage,
  appId: string,
  providerId: string,
): string {
  const providerMessageId = msg.external_message_id?.trim() || msg.id;
  return [
    'live-admission',
    appId,
    providerId,
    msg.chat_jid,
    msg.thread_id?.trim() || 'main',
    providerMessageId,
  ].join(':');
}

export function externalRefForMessage(
  msg: NewMessage,
): Record<string, unknown> {
  const retryTailPayload = sanitizeRetryTailProviderPayload(
    msg.delivery_retry_tail?.providerPayload,
  );
  const retryTail = msg.delivery_retry_tail
    ? {
        canonicalText: msg.delivery_retry_tail.canonicalText,
        ...(retryTailPayload !== undefined
          ? { providerPayload: retryTailPayload }
          : {}),
      }
    : undefined;
  return {
    kind: 'message',
    id: msg.id,
    chat_jid: msg.chat_jid,
    provider: msg.provider,
    thread_id: msg.thread_id,
    external_message_id: msg.external_message_id,
    reply_to_message_id: msg.reply_to_message_id,
    reply_to_sender_name: msg.reply_to_sender_name,
    delivery_retry_tail: retryTail,
  };
}

export class PostgresCanonicalMessageRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async saveMessage(
    msg: NewMessage,
    options: { liveAdmission?: MessageLiveAdmissionInput } = {},
  ): Promise<LiveAdmissionWorkItemEnqueueResult | undefined> {
    return this.db.transaction(async (tx) => {
      const providerId =
        normalizeProviderId(msg.provider ?? providerIdForJid(msg.chat_jid)) ||
        'app';
      const conversationId = await this.graph.ensureConversation(
        msg.chat_jid,
        {
          timestamp: msg.timestamp,
          channel: providerId,
        },
        tx,
      );
      const canonicalThreadId = await this.graph.ensureThread(
        msg.chat_jid,
        msg.thread_id,
        tx,
        { channel: providerId },
      );
      const providerConnectionId =
        (await this.graph.getConversationInstallationId(conversationId, tx)) ??
        `channel-providerConnection:${CANONICAL_APP_ID}:${providerId}`;
      const canonicalMessageId = messageIdFor(msg.chat_jid, msg.id);
      const direction =
        msg.is_from_me || msg.is_bot_message ? 'outbound' : 'inbound';
      const externalMessageId =
        msg.external_message_id ??
        (direction === 'inbound' ? msg.id || null : null);
      if (direction === 'inbound') {
        await this.graph.ensureParticipant(
          {
            conversationId,
            providerId: providerId,
            providerConnectionId,
            externalUserId: msg.sender,
            displayName: msg.sender_name,
            timestamp: msg.timestamp,
          },
          tx,
        );
      }
      await tx
        .insert(pgSchema.messagesPostgres)
        .values({
          id: canonicalMessageId,
          appId: CANONICAL_APP_ID,
          providerId,
          providerConnectionId,
          conversationId,
          threadId: canonicalThreadId,
          externalMessageId,
          externalRefJson: jsonb(externalRefForMessage(msg)),
          direction,
          senderUserId: msg.sender,
          senderDisplayName: msg.sender_name,
          trust: msg.is_bot_message ? 'system' : 'trusted',
          createdAt: msg.timestamp,
          receivedAt: msg.timestamp,
          deliveryStatus: msg.delivery_status ?? null,
          deliveredAt: msg.delivered_at ?? null,
          deliveryError: msg.delivery_error ?? null,
        })
        .onConflictDoUpdate({
          target: pgSchema.messagesPostgres.id,
          set: {
            externalMessageId,
            externalRefJson: jsonb(externalRefForMessage(msg)),
            direction,
            senderUserId: msg.sender,
            senderDisplayName: msg.sender_name,
            trust: msg.is_bot_message ? 'system' : 'trusted',
            deliveryStatus: msg.delivery_status ?? null,
            deliveredAt: msg.delivered_at ?? null,
            deliveryError: msg.delivery_error ?? null,
          },
        });
      await tx
        .insert(pgSchema.messagePartsPostgres)
        .values({
          messageId: canonicalMessageId,
          ordinal: 0,
          kind: 'text',
          payloadJson: jsonb({ kind: 'text', text: msg.content }),
        })
        .onConflictDoUpdate({
          target: [
            pgSchema.messagePartsPostgres.messageId,
            pgSchema.messagePartsPostgres.ordinal,
          ],
          set: {
            kind: sql`excluded.kind`,
            payloadJson: sql`excluded.payload_json`,
          },
        });
      await tx
        .delete(pgSchema.messageAttachmentsPostgres)
        .where(
          eq(pgSchema.messageAttachmentsPostgres.messageId, canonicalMessageId),
        );
      if (msg.attachments && msg.attachments.length > 0) {
        await tx.insert(pgSchema.messageAttachmentsPostgres).values(
          msg.attachments.map((attachment, index) => ({
            id:
              attachment.id ??
              `message-attachment:${canonicalMessageId}:${index}`,
            messageId: canonicalMessageId,
            kind: attachment.kind,
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
            externalRefJson: attachment.externalId
              ? jsonb({
                  kind: 'message_attachment',
                  value: attachment.externalId,
                })
              : null,
            storageRef: attachment.storageRef ?? null,
            trust: msg.is_bot_message ? 'system' : 'trusted',
          })),
        );
      }
      if (direction !== 'inbound' || !options.liveAdmission) {
        return undefined;
      }
      const admission = options.liveAdmission;
      return enqueueLiveAdmissionWorkItem(tx, {
        id: liveAdmissionWorkItemId(admission.appId, canonicalMessageId),
        appId: admission.appId,
        agentId: admission.agentId
          ? normalizeAgentIdForFolder(admission.agentId)
          : null,
        agentSessionId: admission.agentSessionId,
        conversationId: msg.chat_jid,
        threadId: msg.thread_id ?? null,
        queueJid: makeThreadQueueKey(msg.chat_jid, msg.thread_id),
        messageId: canonicalMessageId,
        messageCursor: encodeGroupMessageCursor(toGroupMessageCursor(msg)),
        senderUserId: msg.sender,
        senderDisplayName: msg.sender_name,
        idempotencyKey: liveAdmissionIdempotencyKey(
          msg,
          admission.appId,
          providerId,
        ),
        triggerDecision: admission.triggerDecision,
        now: admission.now ?? msg.timestamp,
      });
    });
  }

  async listInboundMessages(input: {
    jids: string[];
    after?: { timestamp: string; chatJid: string; id: string };
    threadId?: string | null;
    hasThreadFilter?: boolean;
    limit?: number;
  }): Promise<CanonicalOpsMessageRow[]> {
    const jids = input.jids;
    if (jids.length === 0) return [];
    const after = input.after?.timestamp.trim() ? input.after : undefined;
    const afterConversationId = after
      ? conversationIdForJid(after.chatJid)
      : '';
    const afterMessageId = after ? messageIdFor(after.chatJid, after.id) : '';
    const threadId = input.threadId?.trim() || null;
    const m = pgSchema.messagesPostgres;
    const p = pgSchema.messagePartsPostgres;
    const firstPart = this.db
      .select({ payloadJson: p.payloadJson })
      .from(p)
      .where(eq(p.messageId, m.id))
      .orderBy(
        sql`CASE WHEN ${p.kind} = 'text' THEN 0 ELSE 1 END`,
        asc(p.ordinal),
      )
      .limit(1)
      .as('first_part');
    const afterFilter = after
      ? or(
          gt(m.createdAt, after.timestamp),
          and(
            eq(m.createdAt, after.timestamp),
            or(
              gt(m.conversationId, afterConversationId),
              and(
                eq(m.conversationId, afterConversationId),
                gt(m.id, afterMessageId),
              ),
            ),
          ),
        )
      : undefined;
    const canonicalThreadId = threadId
      ? threadIdFor(jids[0] ?? '', threadId)
      : null;
    const threadFilter = input.hasThreadFilter
      ? canonicalThreadId
        ? eq(m.threadId, canonicalThreadId)
        : isNull(m.threadId)
      : undefined;
    return this.db
      .select({
        id: m.id,
        conversation_id: m.conversationId,
        thread_id: m.threadId,
        external_ref_json: sql<string | null>`${m.externalRefJson}::text`,
        direction: m.direction,
        sender_user_id: m.senderUserId,
        sender_display_name: m.senderDisplayName,
        trust: m.trust,
        created_at: m.createdAt,
        received_at: m.receivedAt,
        delivery_status: m.deliveryStatus,
        delivered_at: m.deliveredAt,
        delivery_error: m.deliveryError,
        payload_json: sql<string | null>`${firstPart.payloadJson}::text`,
      })
      .from(m)
      .leftJoinLateral(firstPart, sql`true`)
      .where(
        and(
          inArray(
            m.conversationId,
            jids.map((jid) => conversationIdForJid(jid)),
          ),
          eq(m.direction, 'inbound'),
          afterFilter,
          threadFilter,
        ),
      )
      .orderBy(asc(m.createdAt), asc(m.conversationId), asc(m.id))
      .limit(input.limit ?? 200);
  }

  async listThreadIds(chatJid: string): Promise<Array<string | null>> {
    const m = pgSchema.messagesPostgres;
    const rows = await this.db
      .selectDistinct({ thread_id: m.threadId })
      .from(m)
      .where(eq(m.conversationId, conversationIdForJid(chatJid)))
      .orderBy(sql`${m.threadId} ASC NULLS FIRST`);
    return rows.map((row) => {
      if (!row.thread_id) return null;
      const prefix = `thread:${chatJid}:`;
      return row.thread_id.startsWith(prefix)
        ? row.thread_id.slice(prefix.length)
        : row.thread_id;
    });
  }

  async getLastBotMessageRow(
    chatJid: string,
  ): Promise<CanonicalOpsMessageRow | undefined> {
    const m = pgSchema.messagesPostgres;
    const p = pgSchema.messagePartsPostgres;
    const rows = await this.db
      .select({
        id: m.id,
        conversation_id: m.conversationId,
        thread_id: m.threadId,
        external_ref_json: sql<string | null>`${m.externalRefJson}::text`,
        direction: m.direction,
        sender_user_id: m.senderUserId,
        sender_display_name: m.senderDisplayName,
        trust: m.trust,
        created_at: m.createdAt,
        received_at: m.receivedAt,
        delivery_status: m.deliveryStatus,
        delivered_at: m.deliveredAt,
        delivery_error: m.deliveryError,
        payload_json: sql<string | null>`${p.payloadJson}::text`,
      })
      .from(m)
      .innerJoin(p, and(eq(p.messageId, m.id), eq(p.ordinal, 0)))
      .where(
        and(
          eq(m.conversationId, conversationIdForJid(chatJid)),
          eq(m.trust, 'system'),
        ),
      )
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(1);
    return rows[0];
  }
}
