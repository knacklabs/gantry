/**
 * Embedding error classification shared by the provider, the backfill engine,
 * and hybrid recall. The provider raises typed {@link EmbeddingProviderError}s;
 * the engine maps the codes to resumable pause reasons and recall uses them to
 * decide whether to fall back to lexical-only retrieval.
 */

export type EmbeddingErrorCode =
  | 'provider_quota'
  | 'rate_limit'
  | 'retryable_provider_error'
  | 'invalid_dimension'
  | 'invalid_config'
  | 'daily_budget';

export type EmbeddingPauseReason =
  | 'paused_daily_budget'
  | 'paused_provider_quota'
  | 'paused_rate_limit'
  | 'paused_retryable_provider_error';

export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: EmbeddingErrorCode,
    message: string,
    options: {
      httpStatus?: number;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.code = code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

const QUOTA_HINT =
  /insufficient[_\s-]?quota|billing|exceeded your current quota|payment|out of credit|funds/i;

/**
 * Classify a raw embeddings HTTP response into a typed provider error.
 * 402 / quota / billing -> provider_quota; 429 -> rate_limit (honoring
 * Retry-After); 5xx -> retryable; 400 -> invalid_config (or invalid_dimension
 * when the body references the dimensions parameter); other 4xx -> retryable
 * as a conservative default.
 */
export function classifyEmbeddingHttpError(
  status: number,
  body: string,
  headers?: { get(name: string): string | null },
): EmbeddingProviderError {
  const snippet = body.slice(0, 300);
  if (status === 402 || (status === 403 && QUOTA_HINT.test(body))) {
    return new EmbeddingProviderError(
      'provider_quota',
      `embedding provider quota/billing unavailable (${status}): ${snippet}`,
      { httpStatus: status },
    );
  }
  if (status === 429) {
    if (QUOTA_HINT.test(body)) {
      return new EmbeddingProviderError(
        'provider_quota',
        `embedding provider quota exhausted (${status}): ${snippet}`,
        { httpStatus: status },
      );
    }
    const retryAfterMs = parseRetryAfterMs(headers?.get('retry-after') ?? null);
    return new EmbeddingProviderError(
      'rate_limit',
      `embedding provider rate limited (${status}): ${snippet}`,
      {
        httpStatus: status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }
  if (status >= 500) {
    return new EmbeddingProviderError(
      'retryable_provider_error',
      `embedding provider error (${status}): ${snippet}`,
      { httpStatus: status },
    );
  }
  if (status === 400) {
    if (/dimension/i.test(body)) {
      return new EmbeddingProviderError(
        'invalid_dimension',
        `embedding provider rejected dimensions (${status}): ${snippet}`,
        { httpStatus: status },
      );
    }
    return new EmbeddingProviderError(
      'invalid_config',
      `embedding request invalid (${status}): ${snippet}`,
      { httpStatus: status },
    );
  }
  return new EmbeddingProviderError(
    'retryable_provider_error',
    `embedding request failed (${status}): ${snippet}`,
    { httpStatus: status },
  );
}

/** Wrap a non-HTTP failure (network, abort-adjacent, JSON) as retryable. */
export function classifyEmbeddingThrown(
  error: unknown,
): EmbeddingProviderError {
  if (error instanceof EmbeddingProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new EmbeddingProviderError(
    'retryable_provider_error',
    `embedding request failed: ${message}`,
    { cause: error },
  );
}

const PAUSE_REASON_BY_CODE: Partial<
  Record<EmbeddingErrorCode, EmbeddingPauseReason>
> = {
  daily_budget: 'paused_daily_budget',
  provider_quota: 'paused_provider_quota',
  rate_limit: 'paused_rate_limit',
  retryable_provider_error: 'paused_retryable_provider_error',
};

/** Map a provider error to a resumable pause reason, or null when it is fatal. */
export function pauseReasonForEmbeddingError(
  error: EmbeddingProviderError,
): EmbeddingPauseReason | null {
  return PAUSE_REASON_BY_CODE[error.code] ?? null;
}

/** True when recall should silently fall back to lexical-only for this error. */
export function isLexicalFallbackError(error: unknown): boolean {
  if (error instanceof EmbeddingProviderError) {
    return (
      error.code === 'daily_budget' ||
      error.code === 'provider_quota' ||
      error.code === 'rate_limit' ||
      error.code === 'retryable_provider_error'
    );
  }
  return false;
}
