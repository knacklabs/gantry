import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type {
  LiveAdmissionWorkItemEnqueueResult,
  LiveAdmissionWorkItemNotifier,
} from '../../../../domain/ports/live-turns.js';
import {
  decodeGlobalMessageCursor,
  decodeGroupMessageCursor,
  encodeGlobalMessageCursor,
  toGlobalMessageCursor,
} from '../../../../shared/message-cursor.js';
import type {
  CanonicalOpsMessageRow,
  MessageLiveAdmissionInput,
  PostgresCanonicalMessageRepository,
} from '../repositories/canonical-message-repository.postgres.js';

function hasCursorBoundary(cursor: { timestamp: string }): boolean {
  return cursor.timestamp.trim().length > 0;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class CanonicalMessageOpsService {
  constructor(
    private readonly repository: PostgresCanonicalMessageRepository,
    private readonly liveAdmissionNotifier?: LiveAdmissionWorkItemNotifier,
  ) {}

  async storeMessage(msg: NewMessage): Promise<void> {
    await this.repository.saveMessage(msg);
  }

  async storeMessageWithLiveAdmission(
    msg: NewMessage,
    admission: MessageLiveAdmissionInput,
  ): Promise<LiveAdmissionWorkItemEnqueueResult | undefined> {
    const result = await this.repository.saveMessage(msg, {
      liveAdmission: admission,
    });
    if (result) {
      await this.liveAdmissionNotifier?.notifyLiveAdmissionWorkItem({
        appId: result.item.appId,
        workItemId: result.item.id,
      });
    }
    return result;
  }

  async getNewMessages(
    jids: string[],
    lastCursor: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    const cursor = decodeGlobalMessageCursor(lastCursor);
    const rows = await this.repository.listInboundMessages({
      jids,
      after: hasCursorBoundary(cursor) ? cursor : undefined,
      limit,
    });
    const messages = rows.map((row) => this.mapMessage(row)).slice(0, limit);
    const latest = messages[messages.length - 1];
    return {
      messages,
      newTimestamp: latest
        ? encodeGlobalMessageCursor(toGlobalMessageCursor(latest))
        : lastCursor,
    };
  }

  async getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit: number = 200,
    options: { threadId?: string | null } = {},
  ): Promise<NewMessage[]> {
    const cursor = decodeGroupMessageCursor(sinceCursor);
    const hasThreadFilter = Object.prototype.hasOwnProperty.call(
      options,
      'threadId',
    );
    const rows = await this.repository.listInboundMessages({
      jids: [chatJid],
      after: hasCursorBoundary(cursor)
        ? { timestamp: cursor.timestamp, chatJid, id: cursor.id }
        : undefined,
      threadId: options.threadId ?? null,
      hasThreadFilter,
      limit,
    });
    return rows.map((row) => this.mapMessage(row)).slice(0, limit);
  }

  async getMessageThreadIds(chatJid: string): Promise<Array<string | null>> {
    return this.repository.listThreadIds(chatJid);
  }

  async getLastBotMessageCursor(
    chatJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined> {
    const row = await this.repository.getLastBotMessageRow(chatJid);
    const msg = row ? this.mapMessage(row) : undefined;
    return msg ? { timestamp: msg.timestamp, id: msg.id } : undefined;
  }

  async getLastBotMessageTimestamp(
    chatJid: string,
  ): Promise<string | undefined> {
    return (await this.getLastBotMessageCursor(chatJid))?.timestamp;
  }

  private mapMessage(row: CanonicalOpsMessageRow): NewMessage {
    const ref = parseJson<Partial<NewMessage>>(row.external_ref_json, {});
    const payload = parseJson<{ text?: string }>(row.payload_json, {});
    return {
      id: ref.id || row.id,
      chat_jid: ref.chat_jid || row.conversation_id,
      sender: row.sender_user_id || ref.sender || '',
      sender_name: row.sender_display_name || ref.sender_name || '',
      content: ref.content || payload.text || '',
      timestamp: row.created_at,
      is_from_me: ref.is_from_me ?? row.direction === 'outbound',
      is_bot_message: ref.is_bot_message ?? row.trust === 'system',
      thread_id: ref.thread_id,
      reply_to_message_id: ref.reply_to_message_id,
      reply_to_message_content: ref.reply_to_message_content,
      reply_to_sender_name: ref.reply_to_sender_name,
      external_message_id: ref.external_message_id,
      delivery_status:
        ref.delivery_status ??
        (row.delivery_status as NewMessage['delivery_status']),
      delivered_at: ref.delivered_at ?? row.delivered_at ?? undefined,
      delivery_error: ref.delivery_error ?? row.delivery_error ?? undefined,
    };
  }
}
