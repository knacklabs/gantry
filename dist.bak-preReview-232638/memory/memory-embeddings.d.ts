import type { AppId } from '../domain/app/app.js';
export interface EmbeddingProvider {
    isEnabled(): boolean;
    validateConfiguration(): void;
    validateReady?(options?: {
        signal?: AbortSignal;
    }): Promise<void>;
    expectedDimensions?(): number;
    embedMany(texts: string[], options?: {
        signal?: AbortSignal;
    }): Promise<number[][]>;
    embedOne(text: string, options?: {
        signal?: AbortSignal;
    }): Promise<number[]>;
    /** Present only on providers that support async batch embedding (backfill). */
    batch?: EmbeddingBatchCapability;
}
export interface EmbeddingBatchRequest {
    customId: string;
    input: string;
}
export type EmbeddingBatchState = 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';
export interface EmbeddingBatchPoll {
    batchId: string;
    state: EmbeddingBatchState;
    outputFileId: string | null;
    errorFileId: string | null;
    error: string | null;
}
export interface EmbeddingBatchResultRow {
    customId: string;
    embedding?: number[];
    error?: string;
}
export interface EmbeddingBatchCapability {
    submitBatch(requests: EmbeddingBatchRequest[], options?: {
        signal?: AbortSignal;
    }): Promise<{
        batchId: string;
    }>;
    pollBatch(batchId: string, options?: {
        signal?: AbortSignal;
    }): Promise<EmbeddingBatchPoll>;
    fetchBatchResults(poll: EmbeddingBatchPoll, options?: {
        signal?: AbortSignal;
    }): Promise<EmbeddingBatchResultRow[]>;
}
type EmbeddingCredentialResolver = () => Promise<string | null>;
type EmbeddingBaseUrlResolver = () => Promise<string | null>;
type EmbeddingConnectionResolver = () => Promise<{
    apiKey: string | null;
    baseUrl: string | null;
    revoke?: () => Promise<void>;
} | null>;
type EmbeddingCredentialConfigurationValidator = () => void;
interface EmbeddingProviderOptions {
    model?: string;
    dimensions?: number;
    appId?: AppId;
}
export declare class OpenAIEmbeddingClient implements EmbeddingProvider {
    private readonly apiKey;
    private readonly model;
    private readonly dimensions;
    private readonly validateCredentialConfiguration?;
    private readonly baseUrl;
    private readonly connection?;
    constructor(apiKey?: string | null | EmbeddingCredentialResolver, model?: string, validateCredentialConfiguration?: EmbeddingCredentialConfigurationValidator, baseUrl?: string | EmbeddingBaseUrlResolver, connection?: EmbeddingConnectionResolver, dimensions?: number);
    isEnabled(): boolean;
    expectedDimensions(): number;
    validateConfiguration(): void;
    private resolveApiKey;
    private resolveBaseUrl;
    private resolveConnection;
    validateReady(_options?: {
        signal?: AbortSignal;
    }): Promise<void>;
    embedMany(texts: string[], options?: {
        signal?: AbortSignal;
    }): Promise<number[][]>;
    embedOne(text: string, options?: {
        signal?: AbortSignal;
    }): Promise<number[]>;
    get batch(): EmbeddingBatchCapability;
    private withConnection;
    submitBatch(requests: EmbeddingBatchRequest[], options?: {
        signal?: AbortSignal;
    }): Promise<{
        batchId: string;
    }>;
    pollBatch(batchId: string, options?: {
        signal?: AbortSignal;
    }): Promise<EmbeddingBatchPoll>;
    fetchBatchResults(poll: EmbeddingBatchPoll, options?: {
        signal?: AbortSignal;
    }): Promise<EmbeddingBatchResultRow[]>;
}
export declare class DisabledEmbeddingClient implements EmbeddingProvider {
    isEnabled(): boolean;
    validateConfiguration(): void;
    embedMany(texts: string[], _options?: {
        signal?: AbortSignal;
    }): Promise<number[][]>;
    embedOne(_text: string, _options?: {
        signal?: AbortSignal;
    }): Promise<number[]>;
}
export declare function isEmbeddingProviderRegistered(name: string): boolean;
export declare function createEmbeddingProvider(providerName?: string, options?: EmbeddingProviderOptions): EmbeddingProvider;
export declare function validateEmbeddingProviderReady(providerName?: string): Promise<void>;
export {};
