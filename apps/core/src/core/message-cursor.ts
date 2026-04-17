import { NewMessage } from './types.js';

export interface GroupMessageCursor {
  timestamp: string;
  id: string;
}

export interface GlobalMessageCursor {
  timestamp: string;
  chatJid: string;
  id: string;
}

const EMPTY_GROUP_CURSOR: GroupMessageCursor = {
  timestamp: '',
  id: '',
};

const EMPTY_GLOBAL_CURSOR: GlobalMessageCursor = {
  timestamp: '',
  chatJid: '',
  id: '',
};

function parseCursorRecord(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function encodeGroupMessageCursor(cursor: GroupMessageCursor): string {
  return JSON.stringify(cursor);
}

export function decodeGroupMessageCursor(raw: string): GroupMessageCursor {
  const parsed = parseCursorRecord(raw);
  if (!parsed) {
    const timestamp = raw.trim();
    if (!timestamp) return EMPTY_GROUP_CURSOR;
    return { timestamp, id: '\uffff' };
  }
  const timestamp = readStringField(parsed, 'timestamp');
  const id = readStringField(parsed, 'id');
  if (timestamp === null || id === null) return EMPTY_GROUP_CURSOR;
  return { timestamp, id };
}

export function encodeGlobalMessageCursor(cursor: GlobalMessageCursor): string {
  return JSON.stringify(cursor);
}

export function decodeGlobalMessageCursor(raw: string): GlobalMessageCursor {
  const parsed = parseCursorRecord(raw);
  if (!parsed) {
    const timestamp = raw.trim();
    if (!timestamp) return EMPTY_GLOBAL_CURSOR;
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

export function toGroupMessageCursor(
  message: Pick<NewMessage, 'timestamp' | 'id'>,
): GroupMessageCursor {
  return {
    timestamp: message.timestamp,
    id: message.id,
  };
}

export function toGlobalMessageCursor(
  message: Pick<NewMessage, 'timestamp' | 'id' | 'chat_jid'>,
): GlobalMessageCursor {
  return {
    timestamp: message.timestamp,
    chatJid: message.chat_jid,
    id: message.id,
  };
}
