import type { NewMessage } from '../domain/types.js';
export declare function buildMemoryRecallQueryFromMessages(messages: Array<Pick<NewMessage, 'content' | 'reply_to_message_content'>>): string | undefined;
export declare function buildBoundedMemoryRecallQuery(input: string | undefined): string | undefined;
