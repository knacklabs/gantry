import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { RegisteredGroup } from '../core/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import {
  ensureRuntimeSettings,
  resolveRuntimeStorageSqlitePath,
} from './runtime-settings.js';

export interface RuntimeGroupDb {
  getAllRegisteredGroups(): Record<string, RegisteredGroup>;
  setRegisteredGroup(jid: string, group: RegisteredGroup): void;
  deleteRegisteredGroup(jid: string): void;
  deleteSession(groupFolder: string): void;
  close(): void;
}

function openDatabase(runtimeHome: string): Database.Database {
  const settings = ensureRuntimeSettings(runtimeHome);
  if (settings.storage.provider !== 'sqlite') {
    throw new Error(
      'storage.provider=postgres is not available in host runtime yet. Use storage.provider=sqlite.',
    );
  }
  const dbPath = resolveRuntimeStorageSqlitePath(runtimeHome, settings);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0
    );
  `);

  try {
    db.exec(
      `ALTER TABLE registered_groups ADD COLUMN requires_trigger INTEGER DEFAULT 1`,
    );
  } catch {
    // Column already exists.
  }

  try {
    db.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
  } catch {
    // Column already exists.
  }

  return db;
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
  const db = openDatabase(runtimeHome);

  return {
    getAllRegisteredGroups(): Record<string, RegisteredGroup> {
      const rows = db
        .prepare('SELECT * FROM registered_groups')
        .all() as Array<{
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }>;

      const groups: Record<string, RegisteredGroup> = {};
      for (const row of rows) {
        if (!isValidGroupFolder(row.folder)) {
          continue;
        }

        groups[row.jid] = {
          name: row.name,
          folder: row.folder,
          trigger: row.trigger_pattern,
          added_at: row.added_at,
          agentConfig: parseAgentConfig(row.container_config),
          requiresTrigger:
            row.requires_trigger === null
              ? undefined
              : row.requires_trigger === 1,
          isMain: row.is_main === 1 ? true : undefined,
        };
      }
      return groups;
    },

    setRegisteredGroup(jid: string, group: RegisteredGroup): void {
      if (!isValidGroupFolder(group.folder)) {
        throw new Error(
          `Invalid group folder \"${group.folder}\" for JID ${jid}`,
        );
      }

      db.prepare(
        `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jid,
        group.name,
        group.folder,
        group.trigger,
        group.added_at,
        group.agentConfig ? JSON.stringify(group.agentConfig) : null,
        group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
        group.isMain ? 1 : 0,
      );
    },

    deleteRegisteredGroup(jid: string): void {
      db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    },

    deleteSession(groupFolder: string): void {
      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(
        groupFolder,
      );
    },

    close(): void {
      db.close();
    },
  };
}
