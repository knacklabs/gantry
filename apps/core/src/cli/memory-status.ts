import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  MemoryService,
  type MemoryServiceCounters,
} from '../memory/memory-service.js';
import { readEnvFile } from './env-file.js';
import {
  inspectMemoryHealth,
  inspectMemoryJournalStatus,
  type MemoryHealthInspection,
  type MemoryJournalStatusReport,
} from './memory-health.js';
import { envFilePath } from './runtime-home.js';
import { loadRuntimeSettings } from './runtime-settings.js';

export type MemoryMode =
  | 'keyword-mode'
  | 'semantic-mode'
  | 'full-mode'
  | 'odd-combo';

export interface MemoryLiveCounts {
  items: number;
  procedures: number;
  pinnedItems: number;
  loadBearingItems: number;
  events: number;
}

export interface MemoryRecentEvent {
  eventType: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
}

export interface MemoryCheckpointInfo {
  path: string;
  mtime: string;
  sizeBytes: number;
}

export interface MemorySourceCount {
  source: string;
  fileCount: number;
  lastModified: string | null;
}

export interface MemoryStatusSnapshot {
  runtimeHome: string;
  health: MemoryHealthInspection;
  mode: MemoryMode;
  modeNote: string | null;
  liveDbPath: string;
  liveDbExists: boolean;
  liveDbError: string | null;
  liveCounts: MemoryLiveCounts | null;
  recentEvents: MemoryRecentEvent[];
  journal: MemoryJournalStatusReport;
  latestCheckpoint: MemoryCheckpointInfo | null;
  sourceCounts: MemorySourceCount[];
  counters: MemoryServiceCounters;
  countersScope: 'process-local';
}

export function deriveMemoryMode(health: MemoryHealthInspection): {
  mode: MemoryMode;
  note: string | null;
} {
  const embeddingsOn =
    health.embeddingsEnabled && health.embeddingProvider !== 'disabled';
  const dreamingOn = health.dreamingEnabled;
  if (embeddingsOn && dreamingOn) {
    return {
      mode: 'full-mode',
      note: null,
    };
  }
  if (embeddingsOn) {
    return {
      mode: 'semantic-mode',
      note: null,
    };
  }
  if (dreamingOn) {
    return {
      mode: 'odd-combo',
      note: 'dreaming is on but embeddings are off - dreaming operates on lexical signal only; enable embeddings for semantic consolidation',
    };
  }
  return {
    mode: 'keyword-mode',
    note: null,
  };
}

function resolveLiveDbPath(health: MemoryHealthInspection): string {
  return health.sqlitePath;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name = ?
       LIMIT 1`,
    )
    .get(tableName) as { name?: string } | undefined;
  return typeof row?.name === 'string' && row.name.length > 0;
}

function countRows(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { count?: number } | undefined;
  return Number(row?.count || 0);
}

function readLiveCounts(dbPath: string): {
  counts: MemoryLiveCounts | null;
  recentEvents: MemoryRecentEvent[];
  error: string | null;
} | null {
  if (!fs.existsSync(dbPath)) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const hasItems = tableExists(db, 'memory_items');
    const hasProcedures = tableExists(db, 'memory_procedures');
    const hasEvents = tableExists(db, 'memory_events');
    const counts: MemoryLiveCounts = {
      items: hasItems
        ? countRows(
            db,
            `SELECT COUNT(1) AS count
             FROM memory_items
             WHERE is_deleted = 0`,
          )
        : 0,
      procedures: hasProcedures
        ? countRows(
            db,
            `SELECT COUNT(1) AS count
             FROM memory_procedures
             WHERE is_deleted = 0`,
          )
        : 0,
      pinnedItems: hasItems
        ? countRows(
            db,
            `SELECT COUNT(1) AS count
             FROM memory_items
             WHERE is_deleted = 0
               AND is_pinned = 1`,
          )
        : 0,
      loadBearingItems: hasItems
        ? countRows(
            db,
            `SELECT COUNT(1) AS count
             FROM memory_items
             WHERE is_deleted = 0
               AND load_bearing = 1`,
          )
        : 0,
      events: hasEvents
        ? countRows(
            db,
            `SELECT COUNT(1) AS count
             FROM memory_events`,
          )
        : 0,
    };

    const recentEvents: MemoryRecentEvent[] = hasEvents
      ? (
          db
            .prepare(
              `SELECT event_type, entity_type, entity_id, created_at
               FROM memory_events
               ORDER BY created_at DESC, id DESC
               LIMIT 5`,
            )
            .all() as Array<{
            event_type: string;
            entity_type: string;
            entity_id: string | null;
            created_at: string;
          }>
        ).map((row) => ({
          eventType: row.event_type,
          entityType: row.entity_type,
          entityId: row.entity_id,
          createdAt: row.created_at,
        }))
      : [];

    return {
      counts,
      recentEvents,
      error: null,
    };
  } catch (err) {
    return {
      counts: null,
      recentEvents: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function findLatestCheckpoint(
  journalRoot: string,
): MemoryCheckpointInfo | null {
  const checkpointDir = path.join(journalRoot, 'checkpoints');
  if (!fs.existsSync(checkpointDir)) return null;
  const entries = fs
    .readdirSync(checkpointDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      return /^memory-[0-9]{8}(?:-[0-9]{6}|[0-9]{6})\.db$/.test(entry.name);
    });
  if (entries.length === 0) return null;

  let selected: {
    filePath: string;
    mtimeMs: number;
    size: number;
  } | null = null;
  for (const entry of entries) {
    const filePath = path.join(checkpointDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (!selected || stat.mtimeMs > selected.mtimeMs) {
        selected = {
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      }
    } catch {
      // Ignore unreadable files and keep scanning.
    }
  }

  if (!selected) return null;
  return {
    path: selected.filePath,
    mtime: new Date(selected.mtimeMs).toISOString(),
    sizeBytes: selected.size,
  };
}

function collectSourceCounts(memoryRoot: string): MemorySourceCount[] {
  if (!fs.existsSync(memoryRoot)) return [];
  const entries = fs
    .readdirSync(memoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results: MemorySourceCount[] = [];
  for (const entry of entries) {
    const sourceDir = path.join(memoryRoot, entry.name);
    let fileCount = 0;
    let latest = 0;
    const stack = [sourceDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.name.startsWith('.')) continue;
        const fullPath = path.join(current, child.name);
        if (child.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!child.isFile() || !child.name.toLowerCase().endsWith('.md')) {
          continue;
        }
        fileCount += 1;
        try {
          const stat = fs.statSync(fullPath);
          latest = Math.max(latest, stat.mtimeMs);
        } catch {
          // ignore unreadable files
        }
      }
    }
    results.push({
      source: entry.name,
      fileCount,
      lastModified: latest > 0 ? new Date(latest).toISOString() : null,
    });
  }
  return results;
}

export function collectMemoryStatus(runtimeHome: string): MemoryStatusSnapshot {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const { mode, note } = deriveMemoryMode(health);
  const liveDbPath = resolveLiveDbPath(health);
  const liveDbExists = fs.existsSync(liveDbPath);
  const liveData = readLiveCounts(liveDbPath);
  const journal = inspectMemoryJournalStatus(runtimeHome, settings, env);
  const latestCheckpoint = findLatestCheckpoint(journal.journalRoot);
  const sourceCounts = collectSourceCounts(health.memoryRoot);

  return {
    runtimeHome,
    health,
    mode,
    modeNote: note,
    liveDbPath,
    liveDbExists,
    liveDbError: liveDbExists ? liveData?.error || null : null,
    liveCounts: liveData?.counts || null,
    recentEvents: liveData?.recentEvents || [],
    journal,
    latestCheckpoint,
    sourceCounts,
    counters: MemoryService.getCountersSnapshot(),
    countersScope: 'process-local',
  };
}

export function formatMemoryStatusExtras(
  snapshot: MemoryStatusSnapshot,
): string {
  const lines: string[] = [];
  lines.push(`Mode: ${snapshot.mode}`);
  if (snapshot.modeNote) {
    lines.push(`  note: ${snapshot.modeNote}`);
  }
  lines.push('');
  lines.push('Live DB');
  lines.push(`  path: ${snapshot.liveDbPath}`);
  if (!snapshot.liveDbExists) {
    lines.push('  status: not created yet (no memory writes have landed)');
  } else if (snapshot.liveDbError) {
    lines.push(`  status: read failed (${snapshot.liveDbError})`);
  } else if (!snapshot.liveCounts) {
    lines.push('  status: unavailable');
  } else {
    lines.push(
      `  items=${snapshot.liveCounts.items} procedures=${snapshot.liveCounts.procedures} pinned=${snapshot.liveCounts.pinnedItems} load_bearing=${snapshot.liveCounts.loadBearingItems} events=${snapshot.liveCounts.events}`,
    );
  }
  lines.push('');
  lines.push('Sources');
  if (snapshot.sourceCounts.length === 0) {
    lines.push('  no markdown sources');
  } else {
    for (const source of snapshot.sourceCounts) {
      lines.push(
        `  ${source.source}: files=${source.fileCount}${source.lastModified ? ` (last=${source.lastModified})` : ''}`,
      );
    }
  }
  lines.push('');
  lines.push('Journal');
  lines.push(`  root: ${snapshot.journal.journalRoot}`);
  if (snapshot.journal.groups.length === 0) {
    lines.push('  no groups');
  } else {
    let totalFiles = 0;
    let totalBytes = 0;
    let stale = 0;
    let oversized = 0;
    for (const group of snapshot.journal.groups) {
      totalFiles += group.fileCount;
      totalBytes += group.totalBytes;
      if (group.stale) stale += 1;
      if (group.oversized) oversized += 1;
    }
    lines.push(
      `  groups=${snapshot.journal.groups.length} files=${totalFiles} bytes=${totalBytes} stale=${stale} oversized=${oversized}`,
    );
  }
  if (snapshot.latestCheckpoint) {
    lines.push(
      `  last checkpoint: ${snapshot.latestCheckpoint.path} (${snapshot.latestCheckpoint.mtime}, ${snapshot.latestCheckpoint.sizeBytes} bytes)`,
    );
  } else {
    lines.push('  last checkpoint: none');
  }
  lines.push('');
  lines.push('Counters');
  lines.push('  scope: process-local (this CLI invocation only)');
  for (const [key, value] of Object.entries(snapshot.counters)) {
    lines.push(`  ${key}: ${value}`);
  }
  if (snapshot.recentEvents.length > 0) {
    lines.push('');
    lines.push('Recent events');
    for (const event of snapshot.recentEvents) {
      lines.push(
        `  ${event.createdAt}  ${event.eventType}  ${event.entityType}${event.entityId ? ` ${event.entityId}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
