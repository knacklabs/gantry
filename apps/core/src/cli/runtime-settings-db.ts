import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export interface RegisteredGroupSummary {
  count: number;
  folders: Set<string>;
  error?: string;
}

export function getRegisteredGroupSummary(
  runtimeHome: string,
  prefix: 'tg:%' | 'sl:%',
): RegisteredGroupSummary {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return { count: 0, folders: new Set() };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT jid, folder FROM registered_groups WHERE jid LIKE ?')
      .all(prefix) as Array<{ jid: string; folder: string }>;
    return {
      count: rows.length,
      folders: new Set(
        rows
          .map((row) => row.folder)
          .filter((folder) => typeof folder === 'string' && folder.trim())
          .map((folder) => folder.trim()),
      ),
    };
  } catch (err) {
    return {
      count: 0,
      folders: new Set(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Keep primary error only.
    }
  }
}
