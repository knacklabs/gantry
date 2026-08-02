import { AsyncLocalStorage } from 'node:async_hooks';

import type { Pool, PoolClient } from 'pg';

import { createOperationCounter } from './response-latency-harness.js';

const POSTGRES_TEST_DATABASE_URL_ENV = 'GANTRY_TEST_DATABASE_URL';
const measuredPools = new WeakSet<Pool>();
const measurementScope = new AsyncLocalStorage<symbol>();

export type PostgresEvidenceAvailability =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'blocked';
      blocker: 'missing_gantry_test_database_url';
    }>;

export interface PostgresOperationCounts {
  readonly postgres_statements: number;
  readonly postgres_transactions: number;
}

export interface PostgresOperationMeasurement {
  readonly counts: Readonly<PostgresOperationCounts>;
}

export function classifyPostgresEvidenceAvailability(
  env: Partial<
    Record<typeof POSTGRES_TEST_DATABASE_URL_ENV, string>
  > = process.env,
): PostgresEvidenceAvailability {
  return env[POSTGRES_TEST_DATABASE_URL_ENV]?.trim()
    ? Object.freeze({ status: 'ready' })
    : Object.freeze({
        status: 'blocked',
        blocker: 'missing_gantry_test_database_url',
      });
}

export async function measurePostgresOperations(
  pool: Pool,
  operation: () => Promise<unknown>,
): Promise<PostgresOperationMeasurement> {
  if (measuredPools.has(pool)) {
    throw new Error('Postgres pool is already being measured');
  }
  if (pool.totalCount !== pool.idleCount || pool.waitingCount > 0) {
    throw new Error('Postgres pool must be idle before measurement');
  }
  measuredPools.add(pool);

  const counter = createOperationCounter();
  const scope = Symbol('postgres-operation-measurement');
  const instrumentation = instrumentPoolClients(pool, (query) => {
    if (measurementScope.getStore() !== scope) return;
    const command = postgresCommand(query);
    if (command === 'transaction_start') {
      counter.increment('postgres_transactions');
    } else if (command === 'statement') {
      counter.increment('postgres_statements');
    }
  });

  try {
    await measurementScope.run(scope, operation);
    return Object.freeze({
      counts: Object.freeze({
        postgres_statements: counter.get('postgres_statements'),
        postgres_transactions: counter.get('postgres_transactions'),
      }),
    });
  } finally {
    try {
      instrumentation.restore();
    } finally {
      measuredPools.delete(pool);
    }
  }
}

type PoolConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

type UntypedQuery = (query: unknown, ...args: unknown[]) => unknown;

function instrumentPoolClients(
  pool: Pool,
  onQuery: (query: unknown) => void,
): { restore(): void } {
  const originalConnect = pool.connect;
  const patchedClients = new Map<
    PoolClient,
    { original: PoolClient['query']; patched: PoolClient['query'] }
  >();

  const patchClient = (client: PoolClient): PoolClient => {
    if (patchedClients.has(client)) return client;

    const original = client.query;
    const untypedOriginal = original as unknown as UntypedQuery;
    const patched = ((query: unknown, ...args: unknown[]) => {
      onQuery(query);
      return untypedOriginal.call(client, query, ...args);
    }) as PoolClient['query'];
    patchedClients.set(client, { original, patched });
    client.query = patched;
    return client;
  };

  const connectWithCallback = originalConnect as unknown as (
    callback: PoolConnectCallback,
  ) => void;
  const connectWithPromise =
    originalConnect as unknown as () => Promise<PoolClient>;
  const patchedConnect = ((callback?: PoolConnectCallback) => {
    if (callback) {
      return connectWithCallback.call(pool, (error, client, done) =>
        callback(error, client ? patchClient(client) : undefined, done),
      );
    }
    return connectWithPromise.call(pool).then(patchClient);
  }) as Pool['connect'];
  pool.connect = patchedConnect;

  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      if (pool.connect === patchedConnect) {
        pool.connect = originalConnect;
      }
      for (const [client, query] of patchedClients) {
        if (client.query === query.patched) {
          client.query = query.original;
        }
      }
      patchedClients.clear();
    },
  };
}

type PostgresCommand =
  | 'transaction_start'
  | 'transaction_control'
  | 'statement'
  | 'empty';

function postgresCommand(query: unknown): PostgresCommand {
  const text =
    typeof query === 'string'
      ? query
      : query &&
          typeof query === 'object' &&
          'text' in query &&
          typeof query.text === 'string'
        ? query.text
        : null;
  if (text === null) return 'statement';

  const command = stripLeadingSqlComments(text).trimStart();
  if (!command) return 'empty';
  if (/^(?:BEGIN\b|START\s+TRANSACTION\b)/i.test(command)) {
    return 'transaction_start';
  }
  if (
    /^(?:COMMIT\b|END\b|ROLLBACK\b|ABORT\b|SAVEPOINT\b|RELEASE\b|PREPARE\s+TRANSACTION\b|SET\s+TRANSACTION\b)/i.test(
      command,
    )
  ) {
    return 'transaction_control';
  }
  return 'statement';
}

function stripLeadingSqlComments(sql: string): string {
  let remaining = sql;
  while (true) {
    remaining = remaining.trimStart();
    if (remaining.startsWith('--')) {
      const newline = remaining.indexOf('\n');
      remaining = newline === -1 ? '' : remaining.slice(newline + 1);
      continue;
    }
    if (remaining.startsWith('/*')) {
      let depth = 0;
      let offset = 0;
      while (offset < remaining.length) {
        if (remaining.startsWith('/*', offset)) {
          depth += 1;
          offset += 2;
        } else if (remaining.startsWith('*/', offset)) {
          depth -= 1;
          offset += 2;
          if (depth === 0) break;
        } else {
          offset += 1;
        }
      }
      remaining = depth === 0 ? remaining.slice(offset) : '';
      continue;
    }
    return remaining;
  }
}
