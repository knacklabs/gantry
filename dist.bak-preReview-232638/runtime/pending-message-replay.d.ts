import type { AgentControlOverrides, NewMessage } from '../domain/types.js';
export type GetMessagesSince = (conversationJid: string, sinceCursor: string, limit?: number, options?: {
    threadId?: string | null;
    providerAccountId?: string | null;
}) => Promise<NewMessage[]>;
export interface PendingMessageReplay {
    messages: NewMessage[];
    hasMore: boolean;
    cursorAfter: string | null;
    responseSchema?: Record<string, unknown>;
    agentControls?: AgentControlOverrides;
}
export declare function collectPendingMessagesSince(input: {
    getMessagesSince: GetMessagesSince;
    chatJid: string;
    sinceCursor: string;
    pageSize: number;
    maxMessages?: number;
    options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    };
}): Promise<PendingMessageReplay>;
export declare function buildPendingMessagesContinuationIdempotencyKey(input: {
    queueJid: string;
    sinceCursor: string;
    cursorAfter: string;
    messages: readonly Pick<NewMessage, 'id'>[];
}): string;
