import type { AppMemoryItem } from '../memory/memory-types.js';
import type { MemoryStatusSnapshot } from '../session/session-command-format.js';
type MemoryEmbeddingsStatus = 'disabled' | 'configured';
export declare function getGroupMemoryStatus(input: string | {
    folder: string;
    conversationId?: string;
    userId?: string;
    threadId?: string | null;
    defaultScope?: 'user' | 'group';
}, options?: {
    embeddings?: MemoryEmbeddingsStatus;
    memoryEnabled?: boolean;
}): Promise<MemoryStatusSnapshot>;
export declare function saveGroupProcedureMemory(input: {
    folder: string;
    conversationId?: string;
    userId?: string;
    defaultScope?: 'user' | 'group';
    threadId?: string | null;
    isAdminWrite: boolean;
    title: string;
    body: string;
}): Promise<AppMemoryItem>;
export {};
