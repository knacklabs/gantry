import pg from 'pg';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

const { Pool: PgPool } = pg;

// A read-write pool for boondi-crm's own tables, scoped to the configured
// schema (default: gantry — the same DB the runtime/boondi-admin use). The pool
// size is settings-owned (no hardcoded default in code): parallel extraction
// (max_parallel_extractions) plus the advisory single-flight lease each need a
// connection, so the size is sized to the extractor's concurrency in yaml.
export function createPool(
  databaseUrl: string,
  schema: string,
  maxConnections: number,
  logger?: Pick<Logger, 'warn'>,
): Pool {
  const pool = new PgPool({
    connectionString: databaseUrl,
    max: maxConnections,
    options: `-c search_path=${schema} -c application_name=boondi-crm`,
  });
  pool.on('error', (err) => {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'boondi_crm_postgres_pool_error',
    );
  });
  return pool;
}
