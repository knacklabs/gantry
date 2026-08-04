/**
 * Embedding error classification shared by the provider, the backfill engine,
 * and hybrid recall. The provider raises typed {@link EmbeddingProviderError}s;
 * the engine maps the codes to resumable pause reasons and recall uses them to
 * decide whether to fall back to lexical-only retrieval.
 */
export type EmbeddingErrorCode = 'provider_quota' | 'rate_limit' | 'retryable_provider_error' | 'invalid_dimension' | 'invalid_config' | 'daily_budget';
export type EmbeddingPauseReason = 'paused_daily_budget' | 'paused_provider_quota' | 'paused_rate_limit' | 'paused_retryable_provider_error';
export declare class EmbeddingProviderError extends Error {
    readonly code: EmbeddingErrorCode;
    readonly httpStatus?: number;
    readonly retryAfterMs?: number;
    constructor(code: EmbeddingErrorCode, message: string, options?: {
        httpStatus?: number;
        retryAfterMs?: number;
        cause?: unknown;
    });
}
/**
 * Classify a raw embeddings HTTP response into a typed provider error.
 * 402 / quota / billing -> provider_quota; 429 -> rate_limit (honoring
 * Retry-After); 5xx -> retryable; 400 -> invalid_config (or invalid_dimension
 * when the body references the dimensions parameter); other 4xx -> retryable
 * as a conservative default.
 */
export declare function classifyEmbeddingHttpError(status: number, body: string, headers?: {
    get(name: string): string | null;
}): EmbeddingProviderError;
/** Wrap a non-HTTP failure (network, abort-adjacent, JSON) as retryable. */
export declare function classifyEmbeddingThrown(error: unknown): EmbeddingProviderError;
/** Map a provider error to a resumable pause reason, or null when it is fatal. */
export declare function pauseReasonForEmbeddingError(error: EmbeddingProviderError): EmbeddingPauseReason | null;
/** True when recall should silently fall back to lexical-only for this error. */
export declare function isLexicalFallbackError(error: unknown): boolean;
