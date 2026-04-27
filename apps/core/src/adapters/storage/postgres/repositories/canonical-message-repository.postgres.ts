import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  conversationIdForJid,
  json,
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
  payload_json: string | null;
}

function messageIdFor(chatJid: string, id: string): string {
  return `message:${chatJid}:${id}`;
}

export class PostgresCanonicalMessageRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async saveMessage(msg: NewMessage): Promise<void> {
    await this.db.transaction(async (tx) => {
      const conversationId = await this.graph.ensureConversation(
        msg.chat_jid,
        {
          timestamp: msg.timestamp,
        },
        tx,
      );
      const canonicalThreadId = await this.graph.ensureThread(
        msg.chat_jid,
        msg.thread_id,
        tx,
      );
      const channelProvider = providerIdForJid(msg.chat_jid);
      const channelInstallationId =
        (await this.graph.getConversationInstallationId(conversationId, tx)) ??
        `channel-installation:${CANONICAL_APP_ID}:${channelProvider}`;
      const canonicalMessageId = messageIdFor(msg.chat_jid, msg.id);
      const direction =
        msg.is_from_me || msg.is_bot_message ? 'outbound' : 'inbound';
      await tx
        .insert(pgSchema.messagesPostgres)
        .values({
          id: canonicalMessageId,
          appId: CANONICAL_APP_ID,
          channelProvider,
          channelInstallationId,
          conversationId,
          threadId: canonicalThreadId,
          externalMessageId: msg.id || null,
          externalRefJson: json(msg),
          direction,
          senderUserId: msg.sender,
          senderDisplayName: msg.sender_name,
          trust: msg.is_bot_message ? 'system' : 'trusted',
          createdAt: msg.timestamp,
          receivedAt: msg.timestamp,
        })
        .onConflictDoUpdate({
          target: pgSchema.messagesPostgres.id,
          set: {
            externalRefJson: json(msg),
            direction,
            senderUserId: msg.sender,
            senderDisplayName: msg.sender_name,
            trust: msg.is_bot_message ? 'system' : 'trusted',
          },
        });
      await tx
        .insert(pgSchema.messagePartsPostgres)
        .values({
          messageId: canonicalMessageId,
          ordinal: 0,
          kind: 'text',
          payloadJson: json({ kind: 'text', text: msg.content }),
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
    const afterConversationId = input.after
      ? conversationIdForJid(input.after.chatJid)
      : '';
    const afterMessageId = input.after
      ? messageIdFor(input.after.chatJid, input.after.id)
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
    const afterFilter = input.after
      ? or(
          gt(m.createdAt, input.after.timestamp),
          and(
            eq(m.createdAt, input.after.timestamp),
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
        external_ref_json: m.externalRefJson,
        direction: m.direction,
        sender_user_id: m.senderUserId,
        sender_display_name: m.senderDisplayName,
        trust: m.trust,
        created_at: m.createdAt,
        received_at: m.receivedAt,
        payload_json: firstPart.payloadJson,
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
        external_ref_json: m.externalRefJson,
        direction: m.direction,
        sender_user_id: m.senderUserId,
        sender_display_name: m.senderDisplayName,
        trust: m.trust,
        created_at: m.createdAt,
        received_at: m.receivedAt,
        payload_json: p.payloadJson,
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
