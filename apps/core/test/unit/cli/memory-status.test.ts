import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectMemoryStatus,
  deriveMemoryMode,
} from '@core/cli/memory-status.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/cli/runtime-settings.js';

function createRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-memory-status-test-'),
  );
  fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'logs'), { recursive: true });
  return runtimeHome;
}

function disableMemoryStack(runtimeHome: string): void {
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.enabled = false;
  settings.memory.root = 'memory';
  settings.memory.embeddings.enabled = false;
  settings.memory.embeddings.provider = 'disabled';
  saveRuntimeSettings(runtimeHome, settings);
}

const runtimeHomesToCleanup: string[] = [];

afterEach(() => {
  for (const runtimeHome of runtimeHomesToCleanup.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('memory status snapshot collection', () => {
  it('derives mode from embeddings and dreaming gates', () => {
    const runtimeHome = createRuntimeHome();
    runtimeHomesToCleanup.push(runtimeHome);
    disableMemoryStack(runtimeHome);
    const base = collectMemoryStatus(runtimeHome).health;

    const keyword = deriveMemoryMode({
      ...base,
      embeddingsEnabled: false,
      embeddingProvider: 'disabled',
      dreamingEnabled: false,
    });
    expect(keyword.mode).toBe('keyword-mode');
    expect(keyword.note).toBeNull();

    const semantic = deriveMemoryMode({
      ...base,
      embeddingsEnabled: true,
      embeddingProvider: 'openai',
      dreamingEnabled: false,
    });
    expect(semantic.mode).toBe('semantic-mode');
    expect(semantic.note).toBeNull();

    const full = deriveMemoryMode({
      ...base,
      embeddingsEnabled: true,
      embeddingProvider: 'openai',
      dreamingEnabled: true,
    });
    expect(full.mode).toBe('full-mode');
    expect(full.note).toBeNull();

    const odd = deriveMemoryMode({
      ...base,
      embeddingsEnabled: false,
      embeddingProvider: 'disabled',
      dreamingEnabled: true,
    });
    expect(odd.mode).toBe('odd-combo');
    expect(odd.note).toContain('dreaming is on but embeddings are off');
  });

  it('returns null live stats when no db and no journal are present', () => {
    const runtimeHome = createRuntimeHome();
    runtimeHomesToCleanup.push(runtimeHome);
    disableMemoryStack(runtimeHome);

    const sqlitePath = path.join(runtimeHome, 'memory', '.cache', 'memory.db');
    fs.rmSync(sqlitePath, { force: true });
    fs.rmSync(path.join(runtimeHome, 'memory', '.journal'), {
      recursive: true,
      force: true,
    });

    const snapshot = collectMemoryStatus(runtimeHome);
    expect(snapshot.liveDbExists).toBe(false);
    expect(snapshot.liveDbError).toBeNull();
    expect(snapshot.liveCounts).toBeNull();
    expect(snapshot.recentEvents).toEqual([]);
    expect(snapshot.journal.groups).toEqual([]);
    expect(snapshot.latestCheckpoint).toBeNull();
  });

  it('reports a live db read error when the path exists but is unreadable as sqlite', () => {
    const runtimeHome = createRuntimeHome();
    runtimeHomesToCleanup.push(runtimeHome);
    disableMemoryStack(runtimeHome);

    const sqlitePath = path.join(runtimeHome, 'memory', '.cache', 'memory.db');
    fs.mkdirSync(sqlitePath, { recursive: true });

    const snapshot = collectMemoryStatus(runtimeHome);
    expect(snapshot.liveDbExists).toBe(true);
    expect(snapshot.liveCounts).toBeNull();
    expect(snapshot.liveDbError).toBeTruthy();
    expect(snapshot.recentEvents).toEqual([]);
  });

  it('reads live db counts, recent events, journal groups, and latest checkpoint', () => {
    const runtimeHome = createRuntimeHome();
    runtimeHomesToCleanup.push(runtimeHome);
    disableMemoryStack(runtimeHome);

    const sqlitePath = path.join(runtimeHome, 'memory', '.cache', 'memory.db');
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const db = new Database(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE memory_items (
          id TEXT PRIMARY KEY,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          load_bearing INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE memory_procedures (
          id TEXT PRIMARY KEY,
          is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE memory_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO memory_items(id, is_deleted, is_pinned, load_bearing)
         VALUES (?, ?, ?, ?)`,
      ).run('item-1', 0, 1, 1);
      db.prepare(
        `INSERT INTO memory_items(id, is_deleted, is_pinned, load_bearing)
         VALUES (?, ?, ?, ?)`,
      ).run('item-2', 0, 0, 0);
      db.prepare(
        `INSERT INTO memory_items(id, is_deleted, is_pinned, load_bearing)
         VALUES (?, ?, ?, ?)`,
      ).run('item-deleted', 1, 0, 1);
      db.prepare(
        `INSERT INTO memory_procedures(id, is_deleted)
         VALUES (?, ?)`,
      ).run('proc-1', 0);
      db.prepare(
        `INSERT INTO memory_procedures(id, is_deleted)
         VALUES (?, ?)`,
      ).run('proc-deleted', 1);
      db.prepare(
        `INSERT INTO memory_events(event_type, entity_type, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'memory_saved',
        'memory_item',
        'item-1',
        '{}',
        '2026-04-19T11:00:00.000Z',
      );
      db.prepare(
        `INSERT INTO memory_events(event_type, entity_type, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'memory_patched',
        'memory_item',
        'item-1',
        '{}',
        '2026-04-19T12:00:00.000Z',
      );
    } finally {
      db.close();
    }

    const journalRoot = path.join(runtimeHome, 'memory', '.journal');
    const groupDir = path.join(journalRoot, 'group-a');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'events-2026-04.jsonl'),
      `${JSON.stringify({
        event_id: 'evt-1',
        ts: new Date().toISOString(),
        kind: 'memory.item.saved',
        group_folder: 'group-a',
        scope: 'group',
        actor: 'agent',
        payload: { id: 'item-1' },
      })}\n`,
      'utf-8',
    );

    const checkpointDir = path.join(journalRoot, 'checkpoints');
    fs.mkdirSync(checkpointDir, { recursive: true });
    const olderCheckpoint = path.join(
      checkpointDir,
      'memory-20260418-010000.db',
    );
    const newerCheckpoint = path.join(
      checkpointDir,
      'memory-20260419-020000.db',
    );
    fs.writeFileSync(olderCheckpoint, 'old', 'utf-8');
    fs.writeFileSync(newerCheckpoint, 'new', 'utf-8');
    fs.utimesSync(
      olderCheckpoint,
      new Date('2026-04-18T01:00:00.000Z'),
      new Date('2026-04-18T01:00:00.000Z'),
    );
    fs.utimesSync(
      newerCheckpoint,
      new Date('2026-04-19T02:00:00.000Z'),
      new Date('2026-04-19T02:00:00.000Z'),
    );

    const snapshot = collectMemoryStatus(runtimeHome);
    expect(snapshot.liveDbExists).toBe(true);
    expect(snapshot.liveDbError).toBeNull();
    expect(snapshot.liveCounts).toEqual({
      items: 2,
      procedures: 1,
      pinnedItems: 1,
      loadBearingItems: 1,
      events: 2,
    });
    expect(snapshot.recentEvents).toHaveLength(2);
    expect(snapshot.recentEvents[0]?.eventType).toBe('memory_patched');
    expect(snapshot.journal.groups).toHaveLength(1);
    expect(snapshot.journal.groups[0]?.groupFolder).toBe('group-a');
    expect(snapshot.journal.groups[0]?.fileCount).toBe(1);
    expect(snapshot.latestCheckpoint?.path).toBe(newerCheckpoint);
    expect(snapshot.latestCheckpoint?.sizeBytes).toBe(3);
  });

  it('detects latest checkpoint when filename omits the middle dash', () => {
    const runtimeHome = createRuntimeHome();
    const checkpointDir = path.join(
      runtimeHome,
      'memory',
      '.journal',
      'checkpoints',
    );
    fs.mkdirSync(checkpointDir, { recursive: true });
    const compact = path.join(checkpointDir, 'memory-20260420010101.db');
    fs.writeFileSync(compact, 'checkpoint', 'utf-8');
    fs.utimesSync(
      compact,
      new Date('2026-04-20T01:01:01.000Z'),
      new Date('2026-04-20T01:01:01.000Z'),
    );

    const snapshot = collectMemoryStatus(runtimeHome);
    expect(snapshot.latestCheckpoint?.path).toBe(compact);
    expect(snapshot.latestCheckpoint?.sizeBytes).toBe(10);
  });
});
