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

export interface StorageCapabilities {
  lexicalSearch: boolean;
  vectorSearch: boolean;
  vectorReason?: string;
  textSearch?: boolean;
  textSearchReason?: string;
  jobQueue?: boolean;
  jobQueueReason?: string;
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
    await migratePostgres(this.db, {
      migrationsFolder: postgresMigrationsFolder,
      migrationsSchema: this.schemaName,
    });
    await seedDefaultRuntimeData(this.db);
    await this.migratePgBoss();
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
    }>(
      `SELECT
        EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
        EXISTS(SELECT 1 FROM pg_extension WHERE extname IN ('pg_trgm', 'pg_search')) AS has_text_search,
        (to_regclass('pgboss.version') IS NOT NULL) AS has_job_queue`,
    );
    const row = caps.rows[0];
    const hasVector = Boolean(row?.has_vector);
    const hasTextSearch = Boolean(row?.has_text_search);
    const hasJobQueue = Boolean(row?.has_job_queue);
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
