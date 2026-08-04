import type { AppMemoryItem } from './memory-types.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
export declare const DREAM_EMBEDDING_DEADLINE_MS = 15000;
export declare function runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, options?: {
    signal?: AbortSignal;
    label?: string;
}): Promise<T>;
export declare function storeDreamItemEmbedding(input: {
    db: any;
    now: () => string;
    provider: EmbeddingProvider;
    providerName: string;
    model: string;
    dimensions?: number;
    item: AppMemoryItem;
    contentHash: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<{
    status: 'stored' | 'retryable';
    reason?: string;
}>;
