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
type AgentControls = NonNullable<NewMessage['agentControls']>;

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

function agentControlsFromExternalRef(
  ref: Record<string, unknown>,
): AgentControls | undefined {
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(
    String(ref.effort),
  )
    ? (ref.effort as AgentControls['effort'])
    : undefined;
  const rawThinking = ref.thinking;
  let thinking: AgentControls['thinking'];
  if (
    rawThinking &&
    typeof rawThinking === 'object' &&
    !Array.isArray(rawThinking)
  ) {
    const value = rawThinking as Record<string, unknown>;
    const validKeys = Object.keys(value).every(
      (key) => key === 'mode' || key === 'budgetTokens',
    );
    const validBudget =
      value.budgetTokens === undefined ||
      (typeof value.budgetTokens === 'number' &&
        Number.isInteger(value.budgetTokens) &&
        value.budgetTokens > 0);
    if (validKeys && value.mode === 'off' && value.budgetTokens === undefined) {
      thinking = { mode: 'off' };
    } else if (validKeys && value.mode === 'on' && validBudget) {
      thinking =
        value.budgetTokens === undefined
          ? { mode: 'on' }
          : { mode: 'on', budgetTokens: value.budgetTokens as number };
    }
  }
  const maxOutputTokens =
    typeof ref.max_output_tokens === 'number' &&
    Number.isInteger(ref.max_output_tokens) &&
    ref.max_output_tokens > 0
      ? ref.max_output_tokens
      : undefined;
  return effort || thinking || maxOutputTokens
    ? {
        ...(effort ? { effort } : {}),
        ...(thinking ? { thinking } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      }
    : undefined;
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
    options: {
      threadId?: string | null;
      providerAccountId?: string | null;
    } = {},
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
      providerAccountId: options.providerAccountId,
      hasThreadFilter,
      limit,
    });
    return rows.map((row) => this.mapMessage(row)).slice(0, limit);
  }

  async getContextMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit: number = 200,
    options: {
      threadId?: string | null;
      providerAccountId?: string | null;
    } = {},
  ): Promise<NewMessage[]> {
    const cursor = decodeGroupMessageCursor(sinceCursor);
    const hasThreadFilter = Object.prototype.hasOwnProperty.call(
      options,
      'threadId',
    );
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      after: hasCursorBoundary(cursor)
        ? { timestamp: cursor.timestamp, chatJid, id: cursor.id }
        : undefined,
      threadId: options.threadId ?? null,
      providerAccountId: options.providerAccountId,
      hasThreadFilter,
      limit,
    });
    return rows.map((row) => this.mapMessage(row)).slice(0, limit);
  }

  async getRecentTopLevelMessagesBefore(
    chatJid: string,
    before: Pick<NewMessage, 'timestamp' | 'id'>,
    limit: number = 30,
    options: { providerAccountId?: string | null } = {},
  ): Promise<NewMessage[]> {
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      before: { timestamp: before.timestamp, chatJid, id: before.id },
      providerAccountId: options.providerAccountId,
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
    options: { providerAccountId?: string | null } = {},
  ): Promise<NewMessage[]> {
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      providerAccountId: options.providerAccountId,
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
    options: { providerAccountId?: string | null } = {},
  ): Promise<NewMessage[]> {
    const rows = await this.repository.listContextMessages({
      jids: [chatJid],
      providerAccountId: options.providerAccountId,
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

  async getMessageThreadIds(
    chatJid: string,
    options: { providerAccountId?: string | null } = {},
  ): Promise<Array<string | null>> {
    return this.repository.listThreadIds(chatJid, options);
  }

  async getLastBotMessageCursor(
    chatJid: string,
    options: { providerAccountId?: string | null } = {},
  ): Promise<{ timestamp: string; id: string } | undefined> {
    const row = await this.repository.getLastBotMessageRow(chatJid, options);
    const msg = row ? this.mapMessage(row) : undefined;
    return msg ? { timestamp: msg.timestamp, id: msg.id } : undefined;
  }

  async getLastBotMessageTimestamp(
    chatJid: string,
    options: { providerAccountId?: string | null } = {},
  ): Promise<string | undefined> {
    return (await this.getLastBotMessageCursor(chatJid, options))?.timestamp;
  }

  private mapMessage(row: CanonicalOpsMessageRow): NewMessage {
    const ref = parseJson<Partial<NewMessage>>(row.external_ref_json, {});
    const payload = parseJson<{ text?: string }>(row.payload_json, {});
    const attachments = mapAttachments(row.attachments_json);
    const chatJid = publicConversationJid(row, ref);
    const externalRef = parseJson<Record<string, unknown>>(
      row.external_ref_json,
      {},
    );
    const providerAccountId =
      ref.providerAccountId ??
      (externalRef.provider_account_id as string | undefined);
    const responseSchema = externalRef.response_schema;
    const agentControls = agentControlsFromExternalRef(externalRef);
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
      providerAccountId,
      ...(responseSchema &&
      typeof responseSchema === 'object' &&
      !Array.isArray(responseSchema)
        ? { responseSchema: responseSchema as Record<string, unknown> }
        : {}),
      ...(agentControls ? { agentControls } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      delivery_status:
        ref.delivery_status ??
        (row.delivery_status as NewMessage['delivery_status']),
      delivered_at: ref.delivered_at ?? row.delivered_at ?? undefined,
      delivery_error: ref.delivery_error ?? row.delivery_error ?? undefined,
    };
  }
}
