import { describe, expect, it } from 'vitest';

import { evaluatePostgresStorageCapabilities } from '@core/adapters/storage/postgres/readiness.js';

describe('evaluatePostgresStorageCapabilities', () => {
  it('returns null when all postgres capabilities are present', () => {
    const failure = evaluatePostgresStorageCapabilities({
      lexicalSearch: true,
      vectorSearch: true,
      textSearch: true,
      jobQueue: true,
      runtimeEvents: true,
      eventBusOutbox: true,
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
      runtimeEvents: false,
      runtimeEventsReason:
        'runtime_events indexes are missing: idx_runtime_events_app_cursor',
      eventBusOutbox: false,
      eventBusOutboxReason:
        'event_bus_outbox runtime-event uniqueness constraint is missing: event_bus_outbox_runtime_event_id_key',
    });
    expect(failure?.summary).toContain('Postgres runtime capabilities');
    expect(failure?.details).toEqual([
      'pgvector extension is not installed',
      'pg_search or pg_trgm extension is not installed',
      'pg-boss schema is not initialized (expected table pgboss.version)',
      'runtime_events indexes are missing: idx_runtime_events_app_cursor',
      'event_bus_outbox runtime-event uniqueness constraint is missing: event_bus_outbox_runtime_event_id_key',
    ]);
  });

  it('fails readiness when durable runtime event tables or outbox indexes are missing', () => {
    const failure = evaluatePostgresStorageCapabilities({
      lexicalSearch: true,
      vectorSearch: true,
      textSearch: true,
      jobQueue: true,
      runtimeEvents: false,
      runtimeEventsReason: 'runtime_events table is missing',
      eventBusOutbox: false,
      eventBusOutboxReason:
        'event_bus_outbox indexes are missing: idx_event_bus_outbox_claim_due',
    });

    expect(failure?.details).toEqual([
      'runtime_events table is missing',
      'event_bus_outbox indexes are missing: idx_event_bus_outbox_claim_due',
    ]);
  });
});
