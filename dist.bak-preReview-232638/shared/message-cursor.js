const EMPTY_GROUP_CURSOR = {
    timestamp: '',
    id: '',
};
const EMPTY_GLOBAL_CURSOR = {
    timestamp: '',
    chatJid: '',
    id: '',
};
function parseCursorRecord(raw) {
    if (!raw.trim())
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function readStringField(record, key) {
    const value = record[key];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}
export function encodeGroupMessageCursor(cursor) {
    return JSON.stringify(cursor);
}
export function decodeGroupMessageCursor(raw) {
    const parsed = parseCursorRecord(raw);
    if (!parsed) {
        const timestamp = raw.trim();
        if (!timestamp)
            return EMPTY_GROUP_CURSOR;
        return { timestamp, id: '\uffff' };
    }
    const timestamp = readStringField(parsed, 'timestamp');
    const id = readStringField(parsed, 'id');
    if (timestamp === null || id === null)
        return EMPTY_GROUP_CURSOR;
    return { timestamp, id };
}
export function encodeGlobalMessageCursor(cursor) {
    return JSON.stringify(cursor);
}
export function decodeGlobalMessageCursor(raw) {
    const parsed = parseCursorRecord(raw);
    if (!parsed) {
        const timestamp = raw.trim();
        if (!timestamp)
            return EMPTY_GLOBAL_CURSOR;
        return { timestamp, chatJid: '\uffff', id: '\uffff' };
    }
    const timestamp = readStringField(parsed, 'timestamp');
    const chatJid = readStringField(parsed, 'chatJid');
    const id = readStringField(parsed, 'id');
    if (timestamp === null || chatJid === null || id === null) {
        return EMPTY_GLOBAL_CURSOR;
    }
    return { timestamp, chatJid, id };
}
export function toGroupMessageCursor(message) {
    return {
        timestamp: message.timestamp,
        id: message.id,
    };
}
export function toGlobalMessageCursor(message) {
    return {
        timestamp: message.timestamp,
        chatJid: message.chat_jid,
        id: message.id,
    };
}
