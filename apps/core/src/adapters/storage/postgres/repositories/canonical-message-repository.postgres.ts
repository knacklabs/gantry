import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../../../domain/ports/live-turns.js';
import { agentIdForFolder as normalizeAgentIdForFolder } from '../../../../domain/agent/agent-folder-id.js';
import { normalizeProviderId } from '../../../../channels/provider-registry.js';
import { sanitizeRetryTailProviderPayload } from '../../../../domain/messages/retry-tail-provider-payload.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../../../shared/message-cursor.js';
import { makeAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import * as pgSchema from '../schema/schema.js';
import { enqueueLiveAdmissionWorkItem } from './live-admission-work-item-repository.postgres.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  type CanonicalExecutor,
  conversationIdForJid,
  jsonb,
  PostgresCanonicalGraphRepository,
  providerIdForJid,
  threadIdFor,
} from './canonical-graph-repository.postgres.js';
import {
  attachmentsJsonForMessage,
  existingAttachmentStorageMaps,
  storageRefForIncomingAttachment,
} from './canonical-message-attachments.postgres.js';

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
  attachments_json?: string | null;
}

export interface MessageLiveAdmissionInput {
  appId: string;
  agentId?: string | null;
  agentSessionId?: string | null;
  providerAccountId?: string | null;
  triggerDecision?: Record<string, unknown>;
  now?: string;
}

interface MessageListInput {
  jids: string[];
  providerAccountId?: string | null;
  after?: { timestamp: string; chatJid: string; id: string };
  before?: { timestamp: string; chatJid: string; id: string };
  beforeOrAt?: { timestamp: string; chatJid: string; id: string };
  threadId?: string | null;
  hasThreadFilter?: boolean;
  includeSelfThreadRoots?: boolean;
  limit?: number;
  order?: 'asc' | 'desc';
}

function messageConversationFilter(
  m: typeof pgSchema.messagesPostgres,
  jids: string[],
  providerAccountId?: string | null,
) {
  if (providerAccountId) {
    return and(
      inArray(
        m.conversationId,
        jids.map((jid) => conversationIdForJid(jid, providerAccountId)),
      ),
      eq(m.providerAccountId, providerAccountId),
    );
  }
  return or(
    inArray(
      m.conversationId,
      jids.map((jid) => conversationIdForJid(jid)),
    ),
    inArray(sql<string>`${m.externalRefJson}::jsonb->>'chat_jid'`, jids),
  );
}

function messageThreadFilter(
  m: typeof pgSchema.messagesPostgres,
  jids: string[],
  threadId: string,
  providerAccountId?: string | null,
) {
  return or(
    eq(sql<string>`${m.externalRefJson}::jsonb->>'thread_id'`, threadId),
    inArray(
      m.threadId,
      jids
        .flatMap((jid) => [
          ...(providerAccountId
            ? [threadIdFor(jid, threadId, providerAccountId)]
            : []),
          threadIdFor(jid, threadId),
        ])
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

export function messageIdFor(
  chatJid: string,
  id: string,
  providerAccountId?: string | null,
): string {
  return providerAccountId
    ? `message:${providerAccountId}:${chatJid}:${id}`
    : `message:${chatJid}:${id}`;
}

function parseExternalRef(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function publicThreadIdForRow(
  chatJid: string,
  threadId: string,
  externalRefJson: string | null,
): string {
  const refThreadId = parseExternalRef(externalRefJson).thread_id;
  if (typeof refThreadId === 'string' && refThreadId.length > 0) {
    return refThreadId;
  }
  const unscopedPrefix = `thread:${chatJid}:`;
  if (threadId.startsWith(unscopedPrefix)) {
    return threadId.slice(unscopedPrefix.length);
  }
  const scopedSuffix = `:${chatJid}:`;
  const scopedIndex = threadId.indexOf(scopedSuffix);
  return scopedIndex >= 0
    ? threadId.slice(scopedIndex + scopedSuffix.length)
    : threadId;
}

function liveAdmissionWorkItemId(
  appId: string,
  canonicalMessageId: string,
  providerAccountId?: string | null,
  agentId?: string | null,
) {
  return [
    'live-admission',
    appId,
    agentId?.trim() || 'default-agent',
    providerAccountId?.trim() || 'default-provider-account',
    canonicalMessageId,
  ].join(':');
}

function liveAdmissionIdempotencyKey(
  msg: NewMessage,
  appId: string,
  providerId: string,
  providerAccountId?: string | null,
  agentId?: string | null,
): string {
  const providerMessageId = msg.external_message_id?.trim() || msg.id;
  const providerScope = providerAccountId?.trim() || providerId;
  return [
    'live-admission',
    appId,
    agentId?.trim() || 'default-agent',
    providerScope,
    msg.chat_jid,
    msg.thread_id?.trim() || 'main',
    providerMessageId,
  ].join(':');
}

export function externalRefForMessage(msg: NewMessage) {
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
    provider_account_id: msg.providerAccountId,
    thread_id: msg.thread_id,
    external_message_id: msg.external_message_id,
    reply_to_message_id: msg.reply_to_message_id,
    reply_to_sender_name: msg.reply_to_sender_name,
    response_schema: msg.responseSchema,
    effort: msg.agentControls?.effort,
    thinking: msg.agentControls?.thinking,
    max_output_tokens: msg.agentControls?.maxOutputTokens,
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
    return this.db.transaction((tx) =>
      this.saveMessageWithExecutor(tx, msg, options),
    );
  }

  async saveMessageWithExecutor(
    tx: CanonicalExecutor,
    msg: NewMessage,
    options: { liveAdmission?: MessageLiveAdmissionInput } = {},
  ): Promise<LiveAdmissionWorkItemEnqueueResult | undefined> {
    const providerId =
      normalizeProviderId(msg.provider ?? providerIdForJid(msg.chat_jid)) ||
      'app';
    const requestedProviderAccountId =
      msg.providerAccountId?.trim() ||
      options.liveAdmission?.providerAccountId?.trim() ||
      null;
    const conversationId = await this.graph.ensureConversation(
      msg.chat_jid,
      {
        timestamp: msg.timestamp,
        channel: providerId,
        providerAccountId: requestedProviderAccountId,
      },
      tx,
    );
    const canonicalThreadId = await this.graph.ensureThread(
      msg.chat_jid,
      msg.thread_id,
      tx,
      { channel: providerId, providerAccountId: requestedProviderAccountId },
    );
    const providerAccountId =
      requestedProviderAccountId ??
      (await this.graph.getConversationInstallationId(conversationId, tx)) ??
      `channel-providerAccount:${CANONICAL_APP_ID}:${providerId}`;
    let canonicalMessageId = messageIdFor(
      msg.chat_jid,
      msg.id,
      providerAccountId,
    );
    const direction =
      msg.is_from_me || msg.is_bot_message ? 'outbound' : 'inbound';
    const externalMessageId =
      msg.external_message_id ??
      (direction === 'inbound' ? msg.id || null : null);
    if (externalMessageId && externalMessageId !== msg.id) {
      const duplicateRows = await tx
        .select({ id: pgSchema.messagesPostgres.id })
        .from(pgSchema.messagesPostgres)
        .where(
          and(
            eq(pgSchema.messagesPostgres.providerId, providerId),
            eq(pgSchema.messagesPostgres.providerAccountId, providerAccountId),
            eq(pgSchema.messagesPostgres.conversationId, conversationId),
            canonicalThreadId
              ? eq(pgSchema.messagesPostgres.threadId, canonicalThreadId)
              : isNull(pgSchema.messagesPostgres.threadId),
            eq(pgSchema.messagesPostgres.externalMessageId, externalMessageId),
          ),
        )
        .limit(1);
      canonicalMessageId = duplicateRows[0]?.id ?? canonicalMessageId;
    }
    if (direction === 'inbound') {
      await this.graph.ensureParticipant(
        {
          conversationId,
          providerId: providerId,
          providerAccountId,
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
        providerAccountId,
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
    if (msg.attachments !== undefined) {
      const incomingAttachments = msg.attachments;
      const existingStorageRefs =
        incomingAttachments.length > 0
          ? existingAttachmentStorageMaps(
              await tx
                .select({
                  id: pgSchema.messageAttachmentsPostgres.id,
                  externalRefJson:
                    pgSchema.messageAttachmentsPostgres.externalRefJson,
                  storageRef: pgSchema.messageAttachmentsPostgres.storageRef,
                })
                .from(pgSchema.messageAttachmentsPostgres)
                .where(
                  eq(
                    pgSchema.messageAttachmentsPostgres.messageId,
                    canonicalMessageId,
                  ),
                ),
            )
          : existingAttachmentStorageMaps([]);
      await tx
        .delete(pgSchema.messageAttachmentsPostgres)
        .where(
          eq(pgSchema.messageAttachmentsPostgres.messageId, canonicalMessageId),
        );
      if (incomingAttachments.length > 0) {
        await tx.insert(pgSchema.messageAttachmentsPostgres).values(
          incomingAttachments.map((attachment, index) => {
            const attachmentId =
              attachment.id ??
              `message-attachment:${canonicalMessageId}:${index}`;
            return {
              id: attachmentId,
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
              storageRef: storageRefForIncomingAttachment(
                attachment,
                attachmentId,
                existingStorageRefs,
              ),
              trust: msg.is_bot_message ? 'system' : 'trusted',
            };
          }),
        );
      }
    }
    if (direction !== 'inbound' || !options.liveAdmission) {
      return undefined;
    }
    const admission = options.liveAdmission;
    const agentId = admission.agentId
      ? normalizeAgentIdForFolder(admission.agentId)
      : null;
    return enqueueLiveAdmissionWorkItem(tx, {
      id: liveAdmissionWorkItemId(
        admission.appId,
        canonicalMessageId,
        providerAccountId,
        agentId,
      ),
      appId: admission.appId,
      agentId,
      agentSessionId: admission.agentSessionId,
      conversationId: msg.chat_jid,
      threadId: msg.thread_id ?? null,
      queueJid: makeAgentThreadQueueKey(
        msg.chat_jid,
        agentId,
        msg.thread_id,
        providerAccountId,
      ),
      messageId: canonicalMessageId,
      messageCursor: encodeGroupMessageCursor(toGroupMessageCursor(msg)),
      senderUserId: msg.sender,
      senderDisplayName: msg.sender_name,
      idempotencyKey: liveAdmissionIdempotencyKey(
        msg,
        admission.appId,
        providerId,
        providerAccountId,
        agentId,
      ),
      triggerDecision: admission.triggerDecision,
      now: admission.now ?? msg.timestamp,
    });
  }

  async listInboundMessages(
    input: MessageListInput,
  ): Promise<CanonicalOpsMessageRow[]> {
    return this.listMessages(input, 'inbound');
  }

  async listContextMessages(
    input: MessageListInput,
  ): Promise<CanonicalOpsMessageRow[]> {
    return this.listMessages(input, 'all');
  }

  private async listMessages(
    input: MessageListInput,
    direction: 'inbound' | 'all',
  ): Promise<CanonicalOpsMessageRow[]> {
    const jids = input.jids;
    if (jids.length === 0) return [];
    const after = input.after?.timestamp.trim() ? input.after : undefined;
    const afterConversationId = after
      ? conversationIdForJid(after.chatJid, input.providerAccountId)
      : '';
    const afterMessageId = after
      ? messageIdFor(after.chatJid, after.id, input.providerAccountId)
      : '';
    const before = input.before?.timestamp.trim() ? input.before : undefined;
    const beforeConversationId = before
      ? conversationIdForJid(before.chatJid, input.providerAccountId)
      : '';
    const beforeMessageId = before
      ? messageIdFor(before.chatJid, before.id, input.providerAccountId)
      : '';
    const beforeOrAt = input.beforeOrAt?.timestamp.trim()
      ? input.beforeOrAt
      : undefined;
    const beforeOrAtConversationId = beforeOrAt
      ? conversationIdForJid(beforeOrAt.chatJid, input.providerAccountId)
      : '';
    const beforeOrAtMessageId = beforeOrAt
      ? messageIdFor(beforeOrAt.chatJid, beforeOrAt.id, input.providerAccountId)
      : '';
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
    const beforeFilter = before
      ? or(
          lt(m.createdAt, before.timestamp),
          and(
            eq(m.createdAt, before.timestamp),
            or(
              lt(m.conversationId, beforeConversationId),
              and(
                eq(m.conversationId, beforeConversationId),
                lt(m.id, beforeMessageId),
              ),
            ),
          ),
        )
      : undefined;
    const beforeOrAtFilter = beforeOrAt
      ? or(
          lt(m.createdAt, beforeOrAt.timestamp),
          and(
            eq(m.createdAt, beforeOrAt.timestamp),
            or(
              lt(m.conversationId, beforeOrAtConversationId),
              and(
                eq(m.conversationId, beforeOrAtConversationId),
                lte(m.id, beforeOrAtMessageId),
              ),
            ),
          ),
        )
      : undefined;
    const canonicalThreadId = threadId
      ? threadIdFor(jids[0] ?? '', threadId, input.providerAccountId)
      : null;
    const selfThreadRootFilter =
      input.includeSelfThreadRoots && !canonicalThreadId
        ? or(
            ...jids.map((jid) =>
              and(
                messageConversationFilter(m, [jid], input.providerAccountId),
                eq(
                  m.threadId,
                  input.providerAccountId
                    ? sql<string>`${`thread:${input.providerAccountId}:${jid}:`} || ${m.externalMessageId}`
                    : sql<string>`${`thread:${jid}:`} || ${m.externalMessageId}`,
                ),
              ),
            ),
          )
        : undefined;
    const threadFilter = input.hasThreadFilter
      ? threadId
        ? messageThreadFilter(m, jids, threadId, input.providerAccountId)
        : input.includeSelfThreadRoots
          ? or(isNull(m.threadId), selfThreadRootFilter)
          : isNull(m.threadId)
      : undefined;
    const directionFilter =
      direction === 'inbound'
        ? eq(m.direction, 'inbound')
        : or(
            eq(m.direction, 'inbound'),
            and(eq(m.direction, 'outbound'), eq(m.deliveryStatus, 'sent')),
          );
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
        attachments_json: attachmentsJsonForMessage(m.id),
      })
      .from(m)
      .leftJoinLateral(firstPart, sql`true`)
      .where(
        and(
          messageConversationFilter(m, jids, input.providerAccountId),
          directionFilter,
          afterFilter,
          beforeFilter,
          beforeOrAtFilter,
          threadFilter,
        ),
      )
      .orderBy(
        input.order === 'desc' ? desc(m.createdAt) : asc(m.createdAt),
        input.order === 'desc' ? desc(m.conversationId) : asc(m.conversationId),
        input.order === 'desc' ? desc(m.id) : asc(m.id),
      )
      .limit(input.limit ?? 200);
  }

  async listThreadIds(
    chatJid: string,
    options: { providerAccountId?: string | null } = {},
  ): Promise<Array<string | null>> {
    const m = pgSchema.messagesPostgres;
    const rows = await this.db
      .select({
        thread_id: m.threadId,
        external_ref_json: sql<string | null>`min(${m.externalRefJson}::text)`,
      })
      .from(m)
      .where(messageConversationFilter(m, [chatJid], options.providerAccountId))
      .groupBy(m.threadId)
      .orderBy(sql`${m.threadId} ASC NULLS FIRST`);
    return rows.map((row) => {
      if (!row.thread_id) return null;
      return publicThreadIdForRow(
        chatJid,
        row.thread_id,
        row.external_ref_json,
      );
    });
  }

  async getLastBotMessageRow(
    chatJid: string,
    options: { providerAccountId?: string | null } = {},
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
        attachments_json: attachmentsJsonForMessage(m.id),
      })
      .from(m)
      .innerJoin(p, and(eq(p.messageId, m.id), eq(p.ordinal, 0)))
      .where(
        and(
          messageConversationFilter(m, [chatJid], options.providerAccountId),
          eq(m.trust, 'system'),
        ),
      )
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(1);
    return rows[0];
  }
}
