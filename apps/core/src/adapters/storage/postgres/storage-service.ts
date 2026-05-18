import path from 'path';
import { fileURLToPath } from 'url';

import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';
import { Pool, type PoolConfig } from 'pg';

import { isLocalPostgresHost, parsePostgresConnectionUrl } from './url.js';
import * as pgSchema from './schema/schema.js';
import { seedDefaultRuntimeData } from './seeds.js';

const storageDir = path.dirname(fileURLToPath(import.meta.url));
export const postgresMigrationsFolder = path.join(
  storageDir,
  'schema',
  'migrations',
);
const PGCRYPTO_EXTENSION_LOCK_NAMESPACE = 1_340_193_180;
const PGCRYPTO_EXTENSION_LOCK_KEY = 1;

export interface StorageCapabilities {
  lexicalSearch: boolean;
  vectorSearch: boolean;
  vectorReason?: string;
  textSearch?: boolean;
  textSearchReason?: string;
  jobQueue?: boolean;
  jobQueueReason?: string;
  runtimeEvents?: boolean;
  runtimeEventsReason?: string;
  eventBusOutbox?: boolean;
  eventBusOutboxReason?: string;
}

export interface StorageService {
  migrate(): Promise<void>;
  healthCheck(): Promise<StorageCapabilities>;
  close(): Promise<void>;
}

export interface ResolvedStorageConfig {
  postgresUrl: string | null;
  postgresUrlEnv: string;
  postgresSchema: string;
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(
      `Invalid lowercase PostgreSQL schema identifier: ${identifier}`,
    );
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function resolvePostgresPoolConfig(
  url: string,
  schema: string,
): PoolConfig {
  const parsed = parsePostgresConnectionUrl(url);
  const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  const options = `-c search_path=${quotePostgresIdentifier(schema)},public`;
  parsed.searchParams.set('options', options);
  const connectionString = parsed.toString();
  const isLocal = isLocalPostgresHost(parsed.hostname);
  if (!isLocal) {
    if (
      !sslMode ||
      sslMode === 'disable' ||
      sslMode === 'allow' ||
      sslMode === 'prefer'
    ) {
      throw new Error(
        'Remote postgres URL must set sslmode=require (or stronger) for secure transport',
      );
    }
    return {
      connectionString,
      options,
      ssl: { rejectUnauthorized: true },
    };
  }
  return { connectionString, options };
}

export class PostgresStorageService implements StorageService {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof pgSchema>;

  constructor(
    private readonly url: string,
    private readonly schemaName: string,
  ) {
    this.pool = new Pool(resolvePostgresPoolConfig(url, schemaName));
    this.db = drizzlePg(this.pool, { schema: pgSchema });
  }

  async migrate(): Promise<void> {
    await this.pool.query(
      `CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdentifier(this.schemaName)}`,
    );
    await this.ensurePgcryptoExtension();
    await migratePostgres(this.db, {
      migrationsFolder: postgresMigrationsFolder,
      migrationsSchema: this.schemaName,
    });
    await seedDefaultRuntimeData(this.db);
    await this.migratePgBoss();
  }

  private async ensurePgcryptoExtension(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [
        PGCRYPTO_EXTENSION_LOCK_NAMESPACE,
        PGCRYPTO_EXTENSION_LOCK_KEY,
      ]);
      const existing = await client.query<{ schema_name: string }>(
        `SELECT n.nspname AS schema_name
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'pgcrypto'`,
      );
      const currentSchema = existing.rows[0]?.schema_name;
      if (!currentSchema) {
        await client.query(
          'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public',
        );
      } else if (currentSchema !== 'public') {
        await client.query('ALTER EXTENSION pgcrypto SET SCHEMA public');
      }
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          PGCRYPTO_EXTENSION_LOCK_NAMESPACE,
          PGCRYPTO_EXTENSION_LOCK_KEY,
        ]);
      } finally {
        client.release();
      }
    }
  }

  private async migratePgBoss(): Promise<void> {
    const poolConfig = resolvePostgresPoolConfig(this.url, this.schemaName);
    const boss = new PgBoss({
      connectionString: poolConfig.connectionString,
      schema: 'pgboss',
      createSchema: true,
      migrate: true,
      schedule: false,
      supervise: false,
      ...(poolConfig.ssl ? { ssl: poolConfig.ssl } : {}),
    });
    await boss.start();
    await boss.stop({ graceful: true, close: true, timeout: 10_000 });
  }

  async healthCheck(): Promise<StorageCapabilities> {
    await this.pool.query('SELECT 1');
    const caps = await this.pool.query<{
      has_vector: boolean;
      has_text_search: boolean;
      has_job_queue: boolean;
      has_runtime_events_table: boolean;
      has_event_bus_outbox_table: boolean;
      has_event_bus_outbox_runtime_event_unique: boolean;
      missing_runtime_event_indexes: string[] | null;
      missing_event_bus_outbox_indexes: string[] | null;
    }>(
      `WITH required_runtime_event_indexes(index_name) AS (
          VALUES
            ('idx_runtime_events_app_cursor'),
            ('idx_runtime_events_session_cursor'),
            ('idx_runtime_events_run_cursor'),
            ('idx_runtime_events_job_cursor'),
            ('idx_runtime_events_trigger_cursor'),
            ('idx_runtime_events_conversation_thread_cursor'),
            ('idx_runtime_events_type_cursor'),
            ('idx_runtime_events_webhook_projection')
        ),
        required_event_bus_outbox_indexes(index_name) AS (
          VALUES
            ('idx_event_bus_outbox_claim_due'),
            ('idx_event_bus_outbox_app_event'),
            ('idx_event_bus_outbox_runtime_event'),
            ('idx_event_bus_outbox_pending_runtime_event')
        ),
        current_schema_name AS (
          SELECT $1::text AS schema_name
        ),
        event_tables AS (
          SELECT
            to_regclass(format('%I.%I', $1::text, 'runtime_events')) AS runtime_events_oid,
            to_regclass(format('%I.%I', $1::text, 'event_bus_outbox')) AS event_bus_outbox_oid
        )
        SELECT
          EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
          EXISTS(SELECT 1 FROM pg_extension WHERE extname IN ('pg_trgm', 'pg_search')) AS has_text_search,
          (to_regclass('pgboss.version') IS NOT NULL) AS has_job_queue,
          ((SELECT runtime_events_oid FROM event_tables) IS NOT NULL) AS has_runtime_events_table,
          ((SELECT event_bus_outbox_oid FROM event_tables) IS NOT NULL) AS has_event_bus_outbox_table,
          EXISTS(
            SELECT 1
            FROM pg_constraint c
            JOIN event_tables t ON c.conrelid = t.event_bus_outbox_oid
            WHERE c.conname = 'event_bus_outbox_runtime_event_id_key'
              AND c.contype = 'u'
          ) AS has_event_bus_outbox_runtime_event_unique,
          ARRAY(
            SELECT r.index_name
            FROM required_runtime_event_indexes r
            CROSS JOIN current_schema_name s
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_indexes i
              WHERE i.schemaname = s.schema_name
                AND i.tablename = 'runtime_events'
                AND i.indexname = r.index_name
            )
            ORDER BY r.index_name
          ) AS missing_runtime_event_indexes,
          ARRAY(
            SELECT r.index_name
            FROM required_event_bus_outbox_indexes r
            CROSS JOIN current_schema_name s
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_indexes i
              WHERE i.schemaname = s.schema_name
                AND i.tablename = 'event_bus_outbox'
                AND i.indexname = r.index_name
            )
            ORDER BY r.index_name
          ) AS missing_event_bus_outbox_indexes`,
      [this.schemaName],
    );
    const row = caps.rows[0];
    const hasVector = Boolean(row?.has_vector);
    const hasTextSearch = Boolean(row?.has_text_search);
    const hasJobQueue = Boolean(row?.has_job_queue);
    const hasRuntimeEventsTable = Boolean(row?.has_runtime_events_table);
    const hasEventBusOutboxTable = Boolean(row?.has_event_bus_outbox_table);
    const hasEventBusOutboxRuntimeEventUnique = Boolean(
      row?.has_event_bus_outbox_runtime_event_unique,
    );
    const missingRuntimeEventIndexes = row?.missing_runtime_event_indexes ?? [];
    const missingEventBusOutboxIndexes =
      row?.missing_event_bus_outbox_indexes ?? [];
    const hasRuntimeEvents =
      hasRuntimeEventsTable && missingRuntimeEventIndexes.length === 0;
    const hasEventBusOutbox =
      hasEventBusOutboxTable &&
      hasEventBusOutboxRuntimeEventUnique &&
      missingEventBusOutboxIndexes.length === 0;
    return {
      lexicalSearch: hasTextSearch,
      vectorSearch: hasVector,
      vectorReason: hasVector
        ? undefined
        : 'pgvector extension is not installed',
      textSearch: hasTextSearch,
      textSearchReason: hasTextSearch
        ? undefined
        : 'pg_search or pg_trgm extension is not installed',
      jobQueue: hasJobQueue,
      jobQueueReason: hasJobQueue
        ? undefined
        : 'pg-boss schema is not initialized (expected table pgboss.version)',
      runtimeEvents: hasRuntimeEvents,
      runtimeEventsReason: hasRuntimeEvents
        ? undefined
        : [
            hasRuntimeEventsTable
              ? undefined
              : 'runtime_events table is missing',
            hasRuntimeEventsTable && missingRuntimeEventIndexes.length
              ? `runtime_events indexes are missing: ${missingRuntimeEventIndexes.join(', ')}`
              : undefined,
          ]
            .filter(Boolean)
            .join('; '),
      eventBusOutbox: hasEventBusOutbox,
      eventBusOutboxReason: hasEventBusOutbox
        ? undefined
        : [
            hasEventBusOutboxTable
              ? undefined
              : 'event_bus_outbox table is missing',
            hasEventBusOutboxTable && !hasEventBusOutboxRuntimeEventUnique
              ? 'event_bus_outbox runtime-event uniqueness constraint is missing: event_bus_outbox_runtime_event_id_key'
              : undefined,
            hasEventBusOutboxTable && missingEventBusOutboxIndexes.length
              ? `event_bus_outbox indexes are missing: ${missingEventBusOutboxIndexes.join(', ')}`
              : undefined,
          ]
            .filter(Boolean)
            .join('; '),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createStorageService(
  config: ResolvedStorageConfig,
): PostgresStorageService {
  if (!config.postgresUrl?.trim()) {
    throw new Error(`${config.postgresUrlEnv} is required for runtime storage`);
  }
  return new PostgresStorageService(config.postgresUrl, config.postgresSchema);
}
