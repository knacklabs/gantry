import fs from 'fs';

import Database from 'better-sqlite3';
import { like, sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as sqliteSchema from '../storage/schema/sqlite.js';
import {
  ensureRuntimeSettings,
  resolveRuntimeStorageSqlitePath,
} from './runtime-settings.js';

interface SqliteGroupInspection {
  count: number;
  error?: string;
  unavailable?: boolean;
}

interface SqliteFolderInspection {
  folders: string[];
  error?: string;
  unavailable?: boolean;
}

function resolveDoctorSqliteStorage(runtimeHome: string): {
  dbPath?: string;
  unavailable?: boolean;
  error?: string;
} {
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    const dbPath = resolveRuntimeStorageSqlitePath(runtimeHome, settings);
    return { dbPath };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function withReadonlyDb<T>(
  runtimeHome: string,
  read: (db: BetterSQLite3Database<typeof sqliteSchema>) => T,
): { value?: T; error?: string } {
  const sqliteStorage = resolveDoctorSqliteStorage(runtimeHome);
  if (sqliteStorage.unavailable) {
    return { error: 'storage is unavailable' };
  }
  if (sqliteStorage.error) {
    return { error: sqliteStorage.error };
  }
  const dbPath = sqliteStorage.dbPath;
  if (!dbPath) {
    return { error: 'storage sqlite path is unavailable' };
  }
  if (!fs.existsSync(dbPath)) {
    return { value: undefined };
  }

  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true });
    const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
    return { value: read(db) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      sqlite?.close();
    } catch {
      // Ignore close errors and preserve primary failure.
    }
  }
}

export function inspectProviderGroupCount(
  runtimeHome: string,
  jidPrefix: string,
): SqliteGroupInspection {
  const result = withReadonlyDb(runtimeHome, (db) =>
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(sqliteSchema.registeredGroupsSqlite)
      .where(like(sqliteSchema.registeredGroupsSqlite.jid, `${jidPrefix}%`))
      .get(),
  );
  if (result.error) return { count: 0, error: result.error };
  return { count: result.value?.count ?? 0 };
}

export function inspectTelegramGroupCount(
  runtimeHome: string,
): SqliteGroupInspection {
  return inspectProviderGroupCount(runtimeHome, 'tg:');
}

export function inspectSlackGroupCount(
  runtimeHome: string,
): SqliteGroupInspection {
  return inspectProviderGroupCount(runtimeHome, 'sl:');
}

export function inspectRegisteredGroupCount(
  runtimeHome: string,
): SqliteGroupInspection {
  const result = withReadonlyDb(runtimeHome, (db) =>
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(sqliteSchema.registeredGroupsSqlite)
      .get(),
  );
  if (result.error) return { count: 0, error: result.error };
  return { count: result.value?.count ?? 0 };
}

export function inspectRegisteredGroupFolders(
  runtimeHome: string,
): SqliteFolderInspection {
  const result = withReadonlyDb(runtimeHome, (db) =>
    db
      .select({ folder: sqliteSchema.registeredGroupsSqlite.folder })
      .from(sqliteSchema.registeredGroupsSqlite)
      .all(),
  );
  if (result.error) {
    if (/no such column:\s*folder/i.test(result.error)) {
      return { folders: [] };
    }
    return { folders: [], error: result.error };
  }
  const folders = (result.value || [])
    .map((row) => String(row.folder || '').trim())
    .filter((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value));
  return { folders: [...new Set(folders)] };
}
