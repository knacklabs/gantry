import { setTimeout as delay } from 'node:timers/promises';

import { logger } from '../../../infrastructure/logging/logger.js';

const RETRYABLE_POSTGRES_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '53400',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
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
