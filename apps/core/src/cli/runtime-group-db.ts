import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { count, eq, like } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { RegisteredGroup } from '../core/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { SQLITE_MIGRATIONS } from '../storage/migrations.js';
import * as sqliteSchema from '../storage/schema/sqlite.js';
import {
  ensureRuntimeSettings,
  resolveRuntimeStorageSqlitePath,
} from './runtime-settings.js';

export interface RuntimeGroupDb {
  countRegisteredGroupsByJidPrefix(jidPrefix: string): number;
  getAllRegisteredGroups(): Record<string, RegisteredGroup>;
  setRegisteredGroup(jid: string, group: RegisteredGroup): void;
  deleteRegisteredGroup(jid: string): void;
  deleteSession(groupFolder: string): void;
  close(): void;
}

function openDatabase(
  runtimeHome: string,
  options: { migrate?: boolean; readonly?: boolean } = {},
): {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof sqliteSchema>;
} {
  const settings = ensureRuntimeSettings(runtimeHome);
  if (settings.storage.provider !== 'sqlite') {
    throw new Error(
      'storage.provider=postgres is not available in host runtime yet. Use storage.provider=sqlite.',
    );
  }
  const dbPath = resolveRuntimeStorageSqlitePath(runtimeHome, settings);
  if (!options.readonly) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath, {
    readonly: options.readonly === true,
    fileMustExist: options.readonly === true,
  });
  if (!options.readonly) {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');

  if (options.migrate !== false && !options.readonly) {
    for (const statement of SQLITE_MIGRATIONS) {
      sqlite.exec(statement);
    }
  }

  return {
    sqlite,
    db: drizzleSqlite(sqlite, { schema: sqliteSchema }),
  };
}

function parseAgentConfig(
  raw: string | null,
): RegisteredGroup['agentConfig'] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as RegisteredGroup['agentConfig'];
  } catch {
    return undefined;
  }
}

export function openRuntimeGroupDb(runtimeHome: string): RuntimeGroupDb {
  const { sqlite, db } = openDatabase(runtimeHome);

  return {
    countRegisteredGroupsByJidPrefix(jidPrefix: string): number {
      const row = db
        .select({ count: count() })
        .from(sqliteSchema.registeredGroupsSqlite)
        .where(like(sqliteSchema.registeredGroupsSqlite.jid, `${jidPrefix}%`))
        .get();
      return row?.count ?? 0;
    },

    getAllRegisteredGroups(): Record<string, RegisteredGroup> {
      const rows = db.select().from(sqliteSchema.registeredGroupsSqlite).all();

      const groups: Record<string, RegisteredGroup> = {};
      for (const row of rows) {
        if (!isValidGroupFolder(row.folder)) {
          continue;
        }

        groups[row.jid] = {
          name: row.name,
          folder: row.folder,
          trigger: row.triggerPattern,
          added_at: row.addedAt,
          agentConfig: parseAgentConfig(row.containerConfig),
          requiresTrigger:
            row.requiresTrigger === null
              ? undefined
              : row.requiresTrigger === 1,
          isMain: row.isMain === 1 ? true : undefined,
        };
      }
      return groups;
    },

    setRegisteredGroup(jid: string, group: RegisteredGroup): void {
      if (!isValidGroupFolder(group.folder)) {
        throw new Error(
          `Invalid group folder "${group.folder}" for JID ${jid}`,
        );
      }

      db.insert(sqliteSchema.registeredGroupsSqlite)
        .values({
          jid,
          name: group.name,
          folder: group.folder,
          triggerPattern: group.trigger,
          addedAt: group.added_at,
          containerConfig: group.agentConfig
            ? JSON.stringify(group.agentConfig)
            : null,
          requiresTrigger:
            group.requiresTrigger === undefined
              ? 1
              : group.requiresTrigger
                ? 1
                : 0,
          isMain: group.isMain ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: sqliteSchema.registeredGroupsSqlite.jid,
          set: {
            name: group.name,
            folder: group.folder,
            triggerPattern: group.trigger,
            addedAt: group.added_at,
            containerConfig: group.agentConfig
              ? JSON.stringify(group.agentConfig)
              : null,
            requiresTrigger:
              group.requiresTrigger === undefined
                ? 1
                : group.requiresTrigger
                  ? 1
                  : 0,
            isMain: group.isMain ? 1 : 0,
          },
        })
        .run();
    },

    deleteRegisteredGroup(jid: string): void {
      db.delete(sqliteSchema.registeredGroupsSqlite)
        .where(eq(sqliteSchema.registeredGroupsSqlite.jid, jid))
        .run();
    },

    deleteSession(groupFolder: string): void {
      db.delete(sqliteSchema.sessionsSqlite)
        .where(eq(sqliteSchema.sessionsSqlite.groupFolder, groupFolder))
        .run();
    },

    close(): void {
      sqlite.close();
    },
  };
}

export function openRuntimeGroupReadonlyDb(
  runtimeHome: string,
): RuntimeGroupDb {
  const { sqlite, db } = openDatabase(runtimeHome, {
    migrate: false,
    readonly: true,
  });

  return {
    countRegisteredGroupsByJidPrefix(jidPrefix: string): number {
      const row = db
        .select({ count: count() })
        .from(sqliteSchema.registeredGroupsSqlite)
        .where(like(sqliteSchema.registeredGroupsSqlite.jid, `${jidPrefix}%`))
        .get();
      return row?.count ?? 0;
    },

    getAllRegisteredGroups(): Record<string, RegisteredGroup> {
      const rows = db.select().from(sqliteSchema.registeredGroupsSqlite).all();

      const groups: Record<string, RegisteredGroup> = {};
      for (const row of rows) {
        if (!isValidGroupFolder(row.folder)) {
          continue;
        }

        groups[row.jid] = {
          name: row.name,
          folder: row.folder,
          trigger: row.triggerPattern,
          added_at: row.addedAt,
          agentConfig: parseAgentConfig(row.containerConfig),
          requiresTrigger:
            row.requiresTrigger === null
              ? undefined
              : row.requiresTrigger === 1,
          isMain: row.isMain === 1 ? true : undefined,
        };
      }
      return groups;
    },

    setRegisteredGroup(): void {
      throw new Error('Runtime group DB is readonly');
    },

    deleteRegisteredGroup(): void {
      throw new Error('Runtime group DB is readonly');
    },

    deleteSession(): void {
      throw new Error('Runtime group DB is readonly');
    },

    close(): void {
      sqlite.close();
    },
  };
}
