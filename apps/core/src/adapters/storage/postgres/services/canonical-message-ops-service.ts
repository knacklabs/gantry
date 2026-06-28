import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type {
  LiveAdmissionWorkItemEnqueueResult,
  LiveAdmissionWorkItemNotifier,
} from '../../../../domain/ports/live-turns.js';
import { decodeGroupMessageCursor } from '../../../../shared/message-cursor.js';
import type {
  CanonicalOpsMessageRow,
  MessageLiveAdmissionInput,
  PostgresCanonicalMessageRepository,
} from '../repositories/canonical-message-repository.postgres.js';

type NewMessageAttachment = NonNullable<NewMessage['attachments']>[number];

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

function publicConversationJid(
  row: CanonicalOpsMessageRow,
  ref: Partial<NewMessage>,
): string {
  if (ref.chat_jid) return ref.chat_jid;
  const prefix = 'conversation:';
  return row.conversation_id.startsWith(prefix)
    ? row.conversation_id.slice(prefix.length)
    : row.conversation_id;
}

function publicThreadId(
  row: CanonicalOpsMessageRow,
  chatJid: string,
): string | undefined {
  const threadId = row.thread_id?.trim();
  if (!threadId) return undefined;
  const prefix = `thread:${chatJid}:`;
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toAttachmentKind(
  value: unknown,
): NewMessageAttachment['kind'] | undefined {
  return value === 'image' ||
    value === 'file' ||
    value === 'audio' ||
    value === 'video' ||
    value === 'other'
    ? value
    : undefined;
}

function mapAttachment(value: unknown): NewMessageAttachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const kind = toAttachmentKind(record.kind);
  if (!kind) return undefined;
  const sizeBytes =
    typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes)
      ? record.sizeBytes
      : undefined;
  return {
    kind,
    ...(toStringValue(record.contentType)
      ? { contentType: toStringValue(record.contentType) }
      : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(toStringValue(record.externalId)
      ? { externalId: toStringValue(record.externalId) }
      : {}),
    ...(toStringValue(record.storageRef)
      ? { storageRef: toStringValue(record.storageRef) }
      : {}),
  };
}

function mapAttachments(value: unknown): NewMessageAttachment[] {
  return parseJson<unknown[]>(value, [])
    .map((attachment) => mapAttachment(attachment))
    .filter((attachment): attachment is NewMessageAttachment => !!attachment);
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
      await this.notifyLiveAdmissionWorkItem(result);
    }
    return result;
  }

  async notifyLiveAdmissionWorkItem(
    result: LiveAdmissionWorkItemEnqueueResult,
  ): Promise<void> {
    await this.liveAdmissionNotifier?.notifyLiveAdmissionWorkItem({
      appId: result.item.appId,
      workItemId: result.item.id,
    });
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

  async getRecentTopLevelMessagesBefore(
    chatJid: string,
    before: Pick<NewMessage, 'timestamp' | 'id'>,
    limit: number = 30,
  ): Promise<NewMessage[]> {
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      before: { timestamp: before.timestamp, chatJid, id: before.id },
      threadId: null,
      hasThreadFilter: true,
      includeSelfThreadRoots: true,
      limit,
      order: 'desc',
    });
    return rows
      .map((row) => this.mapMessage(row))
      .reverse()
      .slice(0, limit);
  }

  async getFirstThreadMessages(
    chatJid: string,
    threadId: string,
    limit: number = 50,
  ): Promise<NewMessage[]> {
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      threadId,
      hasThreadFilter: true,
      limit,
    });
    return rows.map((row) => this.mapMessage(row)).slice(0, limit);
  }

  async getLatestThreadMessages(
    chatJid: string,
    threadId: string,
    beforeOrAt: Pick<NewMessage, 'timestamp' | 'id'>,
    limit: number = 50,
  ): Promise<NewMessage[]> {
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      beforeOrAt: {
        timestamp: beforeOrAt.timestamp,
        chatJid,
        id: beforeOrAt.id,
      },
      threadId,
      hasThreadFilter: true,
      limit,
      order: 'desc',
    });
    return rows
      .map((row) => this.mapMessage(row))
      .reverse()
      .slice(0, limit);
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
    const attachments = mapAttachments(row.attachments_json);
    const chatJid = publicConversationJid(row, ref);
    return {
      id: ref.id || row.id,
      chat_jid: chatJid,
      sender: row.sender_user_id || ref.sender || '',
      sender_name: row.sender_display_name || ref.sender_name || '',
      content: ref.content || payload.text || '',
      timestamp: row.created_at,
      is_from_me: ref.is_from_me ?? row.direction === 'outbound',
      is_bot_message: ref.is_bot_message ?? row.trust === 'system',
      thread_id: ref.thread_id ?? publicThreadId(row, chatJid),
      reply_to_message_id: ref.reply_to_message_id,
      reply_to_message_content: ref.reply_to_message_content,
      reply_to_sender_name: ref.reply_to_sender_name,
      external_message_id: ref.external_message_id,
      ...(attachments.length > 0 ? { attachments } : {}),
      delivery_status:
        ref.delivery_status ??
        (row.delivery_status as NewMessage['delivery_status']),
      delivered_at: ref.delivered_at ?? row.delivered_at ?? undefined,
      delivery_error: ref.delivery_error ?? row.delivery_error ?? undefined,
    };
  }
}
