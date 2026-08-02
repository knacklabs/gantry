import { decodeGroupMessageCursor } from '../../../../shared/message-cursor.js';
function hasCursorBoundary(cursor) {
    return cursor.timestamp.trim().length > 0;
}
function parseJson(value, fallback) {
    if (typeof value !== 'string' || value.length === 0)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function publicConversationJid(row, ref) {
    if (ref.chat_jid)
        return ref.chat_jid;
    const prefix = 'conversation:';
    return row.conversation_id.startsWith(prefix)
        ? row.conversation_id.slice(prefix.length)
        : row.conversation_id;
}
function publicThreadId(row, chatJid) {
    const threadId = row.thread_id?.trim();
    if (!threadId)
        return undefined;
    const prefix = `thread:${chatJid}:`;
    return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId;
}
function toStringValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function agentControlsFromExternalRef(ref) {
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(ref.effort))
        ? ref.effort
        : undefined;
    const rawThinking = ref.thinking;
    let thinking;
    if (rawThinking &&
        typeof rawThinking === 'object' &&
        !Array.isArray(rawThinking)) {
        const value = rawThinking;
        const validKeys = Object.keys(value).every((key) => key === 'mode' || key === 'budgetTokens');
        const validBudget = value.budgetTokens === undefined ||
            (typeof value.budgetTokens === 'number' &&
                Number.isInteger(value.budgetTokens) &&
                value.budgetTokens > 0);
        if (validKeys && value.mode === 'off' && value.budgetTokens === undefined) {
            thinking = { mode: 'off' };
        }
        else if (validKeys && value.mode === 'on' && validBudget) {
            thinking =
                value.budgetTokens === undefined
                    ? { mode: 'on' }
                    : { mode: 'on', budgetTokens: value.budgetTokens };
        }
    }
    const maxOutputTokens = typeof ref.max_output_tokens === 'number' &&
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
function toAttachmentKind(value) {
    return value === 'image' ||
        value === 'file' ||
        value === 'audio' ||
        value === 'video' ||
        value === 'other'
        ? value
        : undefined;
}
function mapAttachment(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const record = value;
    const kind = toAttachmentKind(record.kind);
    if (!kind)
        return undefined;
    const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes)
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
function mapAttachments(value) {
    return parseJson(value, [])
        .map((attachment) => mapAttachment(attachment))
        .filter((attachment) => !!attachment);
}
export class CanonicalMessageOpsService {
    repository;
    liveAdmissionNotifier;
    constructor(repository, liveAdmissionNotifier) {
        this.repository = repository;
        this.liveAdmissionNotifier = liveAdmissionNotifier;
    }
    async storeMessage(msg) {
        await this.repository.saveMessage(msg);
    }
    async storeMessageWithLiveAdmission(msg, admission) {
        const result = await this.repository.saveMessage(msg, {
            liveAdmission: admission,
        });
        if (result && result.outcome !== 'overloaded') {
            await this.notifyLiveAdmissionWorkItem(result);
        }
        return result;
    }
    async notifyLiveAdmissionWorkItem(result) {
        if (result.outcome === 'overloaded')
            return;
        await this.liveAdmissionNotifier?.notifyLiveAdmissionWorkItem({
            appId: result.item.appId,
            workItemId: result.item.id,
        });
    }
    async getMessagesSince(chatJid, sinceCursor, limit = 200, options = {}) {
        const cursor = decodeGroupMessageCursor(sinceCursor);
        const hasThreadFilter = Object.prototype.hasOwnProperty.call(options, 'threadId');
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
    async getContextMessagesSince(chatJid, sinceCursor, limit = 200, options = {}) {
        const cursor = decodeGroupMessageCursor(sinceCursor);
        const hasThreadFilter = Object.prototype.hasOwnProperty.call(options, 'threadId');
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
    async getRecentTopLevelMessagesBefore(chatJid, before, limit = 30, options = {}) {
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
    async getFirstThreadMessages(chatJid, threadId, limit = 50, options = {}) {
        const rows = await this.repository.listContextMessages({
            jids: [chatJid],
            providerAccountId: options.providerAccountId,
            threadId,
            hasThreadFilter: true,
            limit,
        });
        return rows.map((row) => this.mapMessage(row)).slice(0, limit);
    }
    async getLatestThreadMessages(chatJid, threadId, beforeOrAt, limit = 50, options = {}) {
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
    async getMessageThreadIds(chatJid, options = {}) {
        return this.repository.listThreadIds(chatJid, options);
    }
    async getLastBotMessageCursor(chatJid, options = {}) {
        const row = await this.repository.getLastBotMessageRow(chatJid, options);
        const msg = row ? this.mapMessage(row) : undefined;
        return msg ? { timestamp: msg.timestamp, id: msg.id } : undefined;
    }
    async getLastBotMessageTimestamp(chatJid, options = {}) {
        return (await this.getLastBotMessageCursor(chatJid, options))?.timestamp;
    }
    mapMessage(row) {
        const ref = parseJson(row.external_ref_json, {});
        const payload = parseJson(row.payload_json, {});
        const attachments = mapAttachments(row.attachments_json);
        const chatJid = publicConversationJid(row, ref);
        const externalRef = parseJson(row.external_ref_json, {});
        const providerAccountId = ref.providerAccountId ??
            externalRef.provider_account_id;
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
                ? { responseSchema: responseSchema }
                : {}),
            ...(agentControls ? { agentControls } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            delivery_status: ref.delivery_status ??
                row.delivery_status,
            delivered_at: ref.delivered_at ?? row.delivered_at ?? undefined,
            delivery_error: ref.delivery_error ?? row.delivery_error ?? undefined,
        };
    }
}
