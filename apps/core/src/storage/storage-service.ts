import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { load as loadSqliteVec } from 'sqlite-vec';

import {
  STORAGE_POSTGRES_URL,
  STORAGE_POSTGRES_URL_ENV,
  STORAGE_PROVIDER,
  STORAGE_SQLITE_PATH,
} from '../core/config.js';
import { POSTGRES_MIGRATIONS, SQLITE_MIGRATIONS } from './migrations.js';
import {
  isLocalPostgresHost,
  parsePostgresConnectionUrl,
} from './postgres-url.js';
import * as pgSchema from './schema/postgres.js';
import * as sqliteSchema from './schema/sqlite.js';

export type StorageProvider = 'sqlite' | 'postgres';

export interface StorageCapabilities {
  lexicalSearch: boolean;
  vectorSearch: boolean;
  vectorReason?: string;
}

export interface StorageService {
  readonly provider: StorageProvider;
  migrate(): Promise<void>;
  healthCheck(): Promise<StorageCapabilities>;
  close(): Promise<void>;
}

export interface ResolvedStorageConfig {
  provider: StorageProvider;
  sqlitePath: string;
  postgresUrl: string | null;
  postgresUrlEnv: string;
}

export function resolveStorageConfigFromRuntime(): ResolvedStorageConfig {
  return {
    provider: STORAGE_PROVIDER === 'postgres' ? 'postgres' : 'sqlite',
    sqlitePath: STORAGE_SQLITE_PATH,
    postgresUrl: STORAGE_POSTGRES_URL,
    postgresUrlEnv: STORAGE_POSTGRES_URL_ENV,
  };
}

function resolvePostgresPoolConfig(url: string): PoolConfig {
  const parsed = parsePostgresConnectionUrl(url);
  const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
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
      connectionString: url,
      ssl: { rejectUnauthorized: true },
    };
  }
  return { connectionString: url };
}

class SqliteStorageService implements StorageService {
  readonly provider: StorageProvider = 'sqlite';
  readonly sqlite: Database.Database;
  readonly db: BetterSQLite3Database<typeof sqliteSchema>;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.db = drizzleSqlite(this.sqlite, { schema: sqliteSchema });
  }

  async migrate(): Promise<void> {
    for (const statement of SQLITE_MIGRATIONS) {
      this.sqlite.exec(statement);
    }
  }

  async healthCheck(): Promise<StorageCapabilities> {
    this.sqlite.prepare('SELECT 1').get();
    try {
      loadSqliteVec(this.sqlite);
      this.sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS __myclaw_vec_probe USING vec0(
          embedding float[4]
        );
        DROP TABLE IF EXISTS __myclaw_vec_probe;
      `);
      return { lexicalSearch: true, vectorSearch: true };
    } catch (err) {
      return {
        lexicalSearch: true,
        vectorSearch: false,
        vectorReason:
          err instanceof Error ? err.message : 'sqlite-vec unavailable',
      };
    }
  }

  async close(): Promise<void> {
    this.sqlite.close();
  }
}

class PostgresStorageService implements StorageService {
  readonly provider: StorageProvider = 'postgres';
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof pgSchema>;

  constructor(url: string) {
    this.pool = new Pool(resolvePostgresPoolConfig(url));
    this.db = drizzlePg(this.pool, { schema: pgSchema });
  }

  async migrate(): Promise<void> {
    for (const statement of POSTGRES_MIGRATIONS) {
      await this.pool.query(statement);
    }
  }

  async healthCheck(): Promise<StorageCapabilities> {
    await this.pool.query('SELECT 1');
    const ext = await this.pool.query<{ installed: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed`,
    );
    const installed = Boolean(ext.rows[0]?.installed);
    return {
      lexicalSearch: true,
      vectorSearch: installed,
      vectorReason: installed
        ? undefined
        : 'pgvector extension is not installed',
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createStorageService(
  config: ResolvedStorageConfig = resolveStorageConfigFromRuntime(),
): StorageService {
  if (config.provider === 'sqlite') {
    return new SqliteStorageService(config.sqlitePath);
  }
  if (!config.postgresUrl?.trim()) {
    throw new Error(
      `storage.provider is postgres but ${config.postgresUrlEnv} is not set`,
    );
  }
  return new PostgresStorageService(config.postgresUrl);
}
