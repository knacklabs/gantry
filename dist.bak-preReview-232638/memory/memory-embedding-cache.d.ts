import type { EmbeddingProvider } from './memory-embeddings.js';
export interface EmbeddingCacheStore {
    getCachedEmbedding(textHash: string, model: string, dimensions: number): Promise<number[] | null>;
    putCachedEmbedding(textHash: string, model: string, dimensions: number, embedding: number[]): Promise<void>;
}
export declare class CachedEmbeddingProvider implements EmbeddingProvider {
    private readonly inner;
    private readonly store;
    private readonly model;
    private readonly dimensions;
    constructor(inner: EmbeddingProvider, store: EmbeddingCacheStore, model?: string, dimensions?: number);
    isEnabled(): boolean;
    validateConfiguration(): void;
    embedOne(text: string, options?: {
        signal?: AbortSignal;
    }): Promise<number[]>;
    embedMany(texts: string[], options?: {
        signal?: AbortSignal;
    }): Promise<number[][]>;
}
export declare function embeddingCacheTextHash(text: string): string;
