import { setTimeout as delay } from 'node:timers/promises';

import { logger } from '../../../infrastructure/logging/logger.js';

// Why retrying on the SAME `this.db` handle is sound (not a same-poisoned-
// connection retry): the wrapped reads are plain drizzle `.select()` calls, not
// transactions, so drizzle runs them via `Pool.query()` (the session only checks
// out a dedicated client for `transaction()` — node-postgres session.js). In
// pg-pool 8.x `Pool.query()` calls `client.release(err)` with the query error on
// completion, and `_release` removes/destroys the client from the pool whenever
// that error is truthy (pg-pool index.js). So ANY failing query — connection-
// class (57P0x/08xxx/"connection terminated") OR query-level ("cached plan must
// not change result type") — evicts the client. Each retry therefore acquires a
// FRESH connection, which re-establishes the socket and re-plans the statement.
// If these reads ever move inside a transaction/checked-out client, this
// eviction guarantee no longer holds and the retry must force a fresh client.

// These wrapped reads are non-transactional autocommit SELECTs that take no
// locks, so transaction-only conflicts (40001 serialization_failure, 40P01
// deadlock_detected) cannot arise here and are deliberately omitted. What
// remains is transient pool/connection loss and server (pooler) unavailability.
const RETRYABLE_POSTGRES_CODES = new Set([
  '53300', // too_many_connections (pool exhaustion)
  '53400', // configuration_limit_exceeded
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '08P01', // protocol_violation
]);

const RETRYABLE_POSTGRES_MESSAGE_PATTERNS = [
  /cached plan must not change result type/i,
  /prepared statement .* (?:does not exist|already exists)/i,
  /connection terminated/i,
  /client has encountered a connection error/i,
  /server closed the connection unexpectedly/i,
  /terminating connection due to administrator command/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /timeout exceeded/i,
];

function objectProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current);
    current = objectProp(current, 'cause');
  }
  return chain;
}

export function isRetryablePostgresReadError(error: unknown): boolean {
  for (const item of errorChain(error)) {
    const code = objectProp(item, 'code');
    if (typeof code === 'string' && RETRYABLE_POSTGRES_CODES.has(code)) {
      return true;
    }
    const message = objectProp(item, 'message');
    if (
      typeof message === 'string' &&
      RETRYABLE_POSTGRES_MESSAGE_PATTERNS.some((pattern) =>
        pattern.test(message),
      )
    ) {
      return true;
    }
  }
  return false;
}

export async function retryPostgresRead<T>(
  operationName: string,
  operation: () => Promise<T>,
  options: { delaysMs?: readonly number[] } = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? [50, 150];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= delaysMs.length || !isRetryablePostgresReadError(err)) {
        throw err;
      }
      logger.warn(
        { err, operationName, nextAttempt: attempt + 2 },
        'Retrying transient Postgres read failure',
      );
      await delay(delaysMs[attempt]);
    }
  }
}
