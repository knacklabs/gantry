import { NewMessage } from '../domain/types.js';
export interface GroupMessageCursor {
    timestamp: string;
    id: string;
}
export interface GlobalMessageCursor {
    timestamp: string;
    chatJid: string;
    id: string;
}
export declare function encodeGroupMessageCursor(cursor: GroupMessageCursor): string;
export declare function decodeGroupMessageCursor(raw: string): GroupMessageCursor;
export declare function encodeGlobalMessageCursor(cursor: GlobalMessageCursor): string;
export declare function decodeGlobalMessageCursor(raw: string): GlobalMessageCursor;
export declare function toGroupMessageCursor(message: Pick<NewMessage, 'timestamp' | 'id'>): GroupMessageCursor;
export declare function toGlobalMessageCursor(message: Pick<NewMessage, 'timestamp' | 'id' | 'chat_jid'>): GlobalMessageCursor;
