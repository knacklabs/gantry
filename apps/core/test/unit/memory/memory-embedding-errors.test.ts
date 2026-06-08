import { describe, expect, it } from 'vitest';

import {
  EmbeddingProviderError,
  classifyEmbeddingHttpError,
  classifyEmbeddingThrown,
  isLexicalFallbackError,
  pauseReasonForEmbeddingError,
} from '@core/memory/memory-embedding-errors.js';

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe('classifyEmbeddingHttpError', () => {
  it('maps 402 to provider_quota', () => {
    const error = classifyEmbeddingHttpError(402, 'payment required');
    expect(error.code).toBe('provider_quota');
    expect(pauseReasonForEmbeddingError(error)).toBe('paused_provider_quota');
  });

  it('maps 429 to rate_limit and honors Retry-After seconds', () => {
    const error = classifyEmbeddingHttpError(
      429,
      'slow down',
      headers({ 'retry-after': '30' }),
    );
    expect(error.code).toBe('rate_limit');
    expect(error.retryAfterMs).toBe(30_000);
    expect(pauseReasonForEmbeddingError(error)).toBe('paused_rate_limit');
  });

  it('maps 429 with a quota hint to provider_quota', () => {
    const error = classifyEmbeddingHttpError(
      429,
      'You exceeded your current quota',
    );
    expect(error.code).toBe('provider_quota');
  });

  it('maps 5xx to retryable_provider_error', () => {
    const error = classifyEmbeddingHttpError(503, 'unavailable');
    expect(error.code).toBe('retryable_provider_error');
    expect(pauseReasonForEmbeddingError(error)).toBe(
      'paused_retryable_provider_error',
    );
  });

  it('maps a 400 dimension error to invalid_dimension (no pause)', () => {
    const error = classifyEmbeddingHttpError(
      400,
      'invalid dimensions for model',
    );
    expect(error.code).toBe('invalid_dimension');
    expect(pauseReasonForEmbeddingError(error)).toBeNull();
  });

  it('maps a generic 400 to invalid_config (no pause)', () => {
    const error = classifyEmbeddingHttpError(400, 'bad model');
    expect(error.code).toBe('invalid_config');
    expect(pauseReasonForEmbeddingError(error)).toBeNull();
  });
});

describe('classifyEmbeddingThrown', () => {
  it('passes through an existing provider error', () => {
    const original = new EmbeddingProviderError('rate_limit', 'x');
    expect(classifyEmbeddingThrown(original)).toBe(original);
  });

  it('wraps an unknown error as retryable', () => {
    const error = classifyEmbeddingThrown(new Error('socket hang up'));
    expect(error.code).toBe('retryable_provider_error');
    expect(error.message).toContain('socket hang up');
  });
});

describe('isLexicalFallbackError', () => {
  it('treats budget/quota/rate-limit/retryable as recoverable', () => {
    for (const code of [
      'daily_budget',
      'provider_quota',
      'rate_limit',
      'retryable_provider_error',
    ] as const) {
      expect(
        isLexicalFallbackError(new EmbeddingProviderError(code, 'x')),
      ).toBe(true);
    }
  });

  it('does not treat invalid config/dimension as recoverable', () => {
    expect(
      isLexicalFallbackError(new EmbeddingProviderError('invalid_config', 'x')),
    ).toBe(false);
    expect(isLexicalFallbackError(new Error('plain'))).toBe(false);
  });
});
