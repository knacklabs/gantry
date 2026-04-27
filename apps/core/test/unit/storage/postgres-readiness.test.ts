import { describe, expect, it } from 'vitest';

import { evaluatePostgresStorageCapabilities } from '@core/adapters/storage/postgres/readiness.js';

describe('evaluatePostgresStorageCapabilities', () => {
  it('returns null when all postgres capabilities are present', () => {
    const failure = evaluatePostgresStorageCapabilities({
      lexicalSearch: true,
      vectorSearch: true,
      textSearch: true,
      jobQueue: true,
    });
    expect(failure).toBeNull();
  });

  it('returns detailed failures for missing postgres capabilities', () => {
    const failure = evaluatePostgresStorageCapabilities({
      lexicalSearch: true,
      vectorSearch: false,
      vectorReason: 'pgvector extension is not installed',
      textSearch: false,
      textSearchReason: 'pg_search or pg_trgm extension is not installed',
      jobQueue: false,
      jobQueueReason:
        'pg-boss schema is not initialized (expected table pgboss.version)',
    });
    expect(failure?.summary).toContain('Postgres runtime capabilities');
    expect(failure?.details).toEqual([
      'pgvector extension is not installed',
      'pg_search or pg_trgm extension is not installed',
      'pg-boss schema is not initialized (expected table pgboss.version)',
    ]);
  });
});
