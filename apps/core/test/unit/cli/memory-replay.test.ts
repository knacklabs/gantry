import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMemoryReplayCommand } from '@core/cli/memory-replay.js';

vi.mock('@clack/prompts', () => ({
  note: vi.fn(),
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-memory-replay-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runMemoryReplayCommand', () => {
  it('replays journal records into a target sqlite database', async () => {
    const root = createTempRoot();
    const from = path.join(root, 'journal');
    const groupDir = path.join(from, 'team');
    fs.mkdirSync(groupDir, { recursive: true });
    const journalFile = path.join(groupDir, 'events-2026-04.jsonl');

    const itemRecord = {
      event_id: 'event-1',
      ts: '2026-04-18T10:00:00.000Z',
      kind: 'memory.item.saved',
      group_folder: 'team',
      scope: 'group',
      actor: 'extractor:precompact',
      payload: {
        id: 'mem-1',
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: 'fact:pet-name',
        value: 'Dog name is Mila.',
        source: 'precompact',
        source_folder: 'items',
        file_path: '/tmp/runtime/memory/items/fact/pet-name.md',
        content_hash: 'abc123',
        indexed_at: '2026-04-18T10:00:00.000Z',
        embedding_pending: true,
        blocked_reason: 'pending_embed',
        confidence: 0.95,
        is_pinned: false,
        version: 1,
        created_at: '2026-04-18T10:00:00.000Z',
        updated_at: '2026-04-18T10:00:00.000Z',
      },
    };
    const reflectionRecord = {
      event_id: 'event-2',
      ts: '2026-04-18T10:00:01.000Z',
      kind: 'reflection.completed',
      group_folder: 'team',
      actor: 'extractor:precompact',
      payload: {
        trigger: 'precompact',
        facts_extracted: 1,
        facts_saved: 1,
      },
    };
    fs.writeFileSync(
      journalFile,
      `${JSON.stringify(itemRecord)}\n${JSON.stringify(reflectionRecord)}\n`,
      'utf-8',
    );

    const targetDb = path.join(root, 'replayed.db');
    const code = await runMemoryReplayCommand([
      `--from=${from}`,
      `--to=${targetDb}`,
    ]);
    expect(code).toBe(0);
    expect(fs.existsSync(targetDb)).toBe(true);

    const db = new Database(targetDb, { readonly: true });
    try {
      const itemCount = db
        .prepare(
          `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0`,
        )
        .get() as { count?: number };
      const reflectionCount = db
        .prepare(
          `SELECT COUNT(1) AS count FROM memory_events WHERE event_type = 'reflection_completed'`,
        )
        .get() as { count?: number };
      const replayedItem = db
        .prepare(
          `SELECT source_folder, file_path, content_hash, indexed_at, embedding_pending, blocked_reason
           FROM memory_items
           WHERE id = 'mem-1'
           LIMIT 1`,
        )
        .get() as
        | {
            source_folder?: string;
            file_path?: string;
            content_hash?: string;
            indexed_at?: string;
            embedding_pending?: number;
            blocked_reason?: string | null;
          }
        | undefined;
      expect(itemCount.count).toBe(1);
      expect(reflectionCount.count).toBe(1);
      expect(replayedItem?.source_folder).toBe('items');
      expect(replayedItem?.file_path).toBe('');
      expect(replayedItem?.content_hash).toBe('abc123');
      expect(replayedItem?.indexed_at).toBe('2026-04-18T10:00:00.000Z');
      expect(replayedItem?.embedding_pending).toBe(1);
      expect(replayedItem?.blocked_reason).toBe('pending_embed');
    } finally {
      db.close();
    }
  });

  it('supports dry-run without creating target db', async () => {
    const root = createTempRoot();
    const from = path.join(root, 'journal');
    const groupDir = path.join(from, 'team');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'events-2026-04.jsonl'), '', 'utf-8');

    const targetDb = path.join(root, 'dry-run.db');
    const code = await runMemoryReplayCommand([
      `--from=${from}`,
      `--to=${targetDb}`,
      '--dry-run',
    ]);
    expect(code).toBe(0);
    expect(fs.existsSync(targetDb)).toBe(false);
  });

  it('patches by mapped item id when key changes', async () => {
    const root = createTempRoot();
    const from = path.join(root, 'journal');
    const groupDir = path.join(from, 'team');
    fs.mkdirSync(groupDir, { recursive: true });
    const journalFile = path.join(groupDir, 'events-2026-04.jsonl');

    const savedRecord = {
      event_id: 'event-a',
      ts: '2026-04-18T10:00:00.000Z',
      kind: 'memory.item.saved',
      group_folder: 'team',
      scope: 'group',
      actor: 'extractor:precompact',
      payload: {
        id: 'mem-1',
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: 'fact:old-key',
        value: 'old value',
        source: 'precompact',
        confidence: 0.9,
        is_pinned: false,
        version: 1,
        created_at: '2026-04-18T10:00:00.000Z',
        updated_at: '2026-04-18T10:00:00.000Z',
      },
    };
    const patchedRecord = {
      event_id: 'event-b',
      ts: '2026-04-18T10:00:01.000Z',
      kind: 'memory.item.patched',
      group_folder: 'team',
      scope: 'group',
      actor: 'extractor:precompact',
      payload: {
        id: 'mem-1',
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: 'fact:new-key',
        value: 'new value',
        source: 'precompact',
        confidence: 0.92,
        is_pinned: false,
        version: 2,
        created_at: '2026-04-18T10:00:00.000Z',
        updated_at: '2026-04-18T10:00:01.000Z',
      },
    };
    fs.writeFileSync(
      journalFile,
      `${JSON.stringify(savedRecord)}\n${JSON.stringify(patchedRecord)}\n`,
      'utf-8',
    );

    const targetDb = path.join(root, 'replayed.db');
    const code = await runMemoryReplayCommand([
      `--from=${from}`,
      `--to=${targetDb}`,
    ]);
    expect(code).toBe(0);

    const db = new Database(targetDb, { readonly: true });
    try {
      const countRow = db
        .prepare(
          `SELECT COUNT(1) AS count FROM memory_items WHERE is_deleted = 0 AND group_folder = 'team'`,
        )
        .get() as { count?: number };
      const row = db
        .prepare(
          `SELECT key, value, version
           FROM memory_items
           WHERE is_deleted = 0 AND group_folder = 'team'
           LIMIT 1`,
        )
        .get() as
        | { key?: string; value?: string; version?: number }
        | undefined;
      expect(countRow.count).toBe(1);
      expect(row?.key).toBe('fact:new-key');
      expect(row?.value).toBe('new value');
      expect(row?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('is idempotent for duplicate snapshot versions', async () => {
    const root = createTempRoot();
    const from = path.join(root, 'journal');
    const groupDir = path.join(from, 'team');
    fs.mkdirSync(groupDir, { recursive: true });
    const journalFile = path.join(groupDir, 'events-2026-04.jsonl');
    const recordA = {
      event_id: 'event-a',
      ts: '2026-04-18T10:00:00.000Z',
      kind: 'memory.item.saved',
      group_folder: 'team',
      scope: 'group',
      actor: 'extractor:precompact',
      payload: {
        id: 'mem-idempotent',
        scope: 'group',
        group_folder: 'team',
        user_id: null,
        kind: 'fact',
        key: 'fact:idempotent',
        value: 'keep stable',
        source: 'precompact',
        confidence: 0.9,
        is_pinned: false,
        version: 1,
        created_at: '2026-04-18T10:00:00.000Z',
        updated_at: '2026-04-18T10:00:00.000Z',
      },
    };
    const recordB = {
      ...recordA,
      event_id: 'event-b',
      ts: '2026-04-18T10:00:01.000Z',
    };
    fs.writeFileSync(
      journalFile,
      `${JSON.stringify(recordA)}\n${JSON.stringify(recordB)}\n`,
      'utf-8',
    );

    const targetDb = path.join(root, 'replayed.db');
    const code = await runMemoryReplayCommand([
      `--from=${from}`,
      `--to=${targetDb}`,
    ]);
    expect(code).toBe(0);

    const db = new Database(targetDb, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT COUNT(1) AS count, MAX(version) AS version
           FROM memory_items
           WHERE id = 'mem-idempotent'`,
        )
        .get() as { count?: number; version?: number };
      expect(row.count).toBe(1);
      expect(row.version).toBe(1);
    } finally {
      db.close();
    }
  });
});
