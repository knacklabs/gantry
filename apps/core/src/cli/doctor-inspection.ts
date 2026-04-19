import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { ensureRuntimeSettings, RuntimeSettings } from './runtime-settings.js';

function inspectGroupCount(
  runtimeHome: string,
  query: string,
): {
  count: number;
  error?: string;
} {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return { count: 0 };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.prepare(query).get() as { count: number };
    return { count: row.count };
  } catch (err) {
    return {
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors and preserve primary failure.
    }
  }
}

export function inspectTelegramGroupCount(runtimeHome: string): {
  count: number;
  error?: string;
} {
  return inspectGroupCount(
    runtimeHome,
    `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE 'tg:%'`,
  );
}

export function inspectSlackGroupCount(runtimeHome: string): {
  count: number;
  error?: string;
} {
  return inspectGroupCount(
    runtimeHome,
    `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE 'sl:%'`,
  );
}

export function inspectRegisteredGroupCount(runtimeHome: string): {
  count: number;
  error?: string;
} {
  return inspectGroupCount(
    runtimeHome,
    `SELECT COUNT(*) as count FROM registered_groups`,
  );
}

export function loadSettingsForDoctor(runtimeHome: string): {
  settings?: RuntimeSettings;
  error?: string;
} {
  try {
    return { settings: ensureRuntimeSettings(runtimeHome) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
