import { describe, expect, it, vi } from 'vitest';

import {
  isRetryablePostgresReadError,
  retryPostgresRead,
} from '@core/adapters/storage/postgres/postgres-read-retry.js';

describe('postgres read retry', () => {
  it('detects transient postgres errors from wrapped causes', () => {
    const err = new Error('Failed query', {
      cause: Object.assign(
        new Error('cached plan must not change result type'),
        {
          code: '0A000',
        },
      ),
    });

    expect(isRetryablePostgresReadError(err)).toBe(true);
  });

  it('does not classify deterministic schema errors as retryable', () => {
    const err = new Error('Failed query', {
      cause: Object.assign(new Error('column does not exist'), {
        code: '42703',
      }),
    });

    expect(isRetryablePostgresReadError(err)).toBe(false);
  });

  it('retries read operations that fail transiently', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Failed query', {
          cause: Object.assign(
            new Error('Connection terminated unexpectedly'),
            {
              code: '08006',
            },
          ),
        }),
      )
      .mockResolvedValueOnce('ok');

    await expect(
      retryPostgresRead('test.read', operation, { delaysMs: [0] }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
