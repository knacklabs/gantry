import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_VECTOR_DIMENSIONS } from '@core/core/config.js';
import { runMemoryCleanupOnce } from '@core/memory/cleanup-job.js';
import { MemoryIndexer } from '@core/memory/memory-indexer.js';
import { MemoryRootService } from '@core/memory/memory-root.js';
import { MemoryStore } from '@core/memory/memory-store.js';

const tempRoots: string[] = [];

function vector(seed: number): number[] {
  const out = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
  out[seed % MEMORY_VECTOR_DIMENSIONS] = 1;
  return out;
}

afterEach(() => {
  MemoryRootService.resetForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runMemoryCleanupOnce', () => {
  it('purges deleted items, removes mirrors, and prevents reindex resurrection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cleanup-'));
    tempRoots.push(root);
    MemoryRootService.setRootForTests(path.join(root, 'memory'));
    const memoryRoot = MemoryRootService.getInstance();
    const sqlitePath = memoryRoot.getSqliteCachePath();
    const itemMirrorPath = path.join(
      memoryRoot.getLayout().itemsDir,
      'fact',
      'cleanup_target.md',
    );
    fs.mkdirSync(path.dirname(itemMirrorPath), { recursive: true });
    fs.writeFileSync(
      itemMirrorPath,
      [
        '---',
        'scope: group',
        'group_folder: team',
        'key: cleanup_target',
        'kind: fact',
        'source: test',
        'confidence: 0.9',
        '---',
        '',
        '## Value',
        'This row should be purged.',
        '',
      ].join('\n'),
    );

    const store = new MemoryStore(sqlitePath);
    const saved = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'cleanup_target',
      value: 'This row should be purged.',
      source: 'test',
      confidence: 0.9,
      source_folder: 'items',
      file_path: itemMirrorPath,
    });
    store.saveItemEmbedding(saved.id, vector(3));
    store.close();

    const dbBefore = new Database(sqlitePath);
    dbBefore
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1,
             deleted_at = datetime('now', '-365 days')
         WHERE id = ?`,
      )
      .run(saved.id);
    dbBefore
      .prepare(
        `INSERT INTO memory_usage_events(item_id, turn_id, event, at)
         VALUES (?, ?, 'retrieved', datetime('now', '-30 days'))`,
      )
      .run(saved.id, 'turn-1');
    const mapCountBefore = dbBefore
      .prepare(
        `SELECT COUNT(1) AS count FROM memory_item_vector_map WHERE item_id = ?`,
      )
      .get(saved.id) as { count: number };
    expect(mapCountBefore.count).toBe(1);
    dbBefore.close();

    const result = runMemoryCleanupOnce();
    expect(result.purgedItems).toBe(1);
    expect(result.checkpointCreated).toContain(
      path.join('memory', '.journal', 'checkpoints', 'memory-'),
    );

    const dbAfter = new Database(sqlitePath);
    const itemAfter = dbAfter
      .prepare(`SELECT 1 AS found FROM memory_items WHERE id = ?`)
      .get(saved.id);
    const usageAfter = dbAfter
      .prepare(
        `SELECT COUNT(1) AS count FROM memory_usage_events WHERE item_id = ?`,
      )
      .get(saved.id) as { count: number };
    const mapAfter = dbAfter
      .prepare(
        `SELECT COUNT(1) AS count FROM memory_item_vector_map WHERE item_id = ?`,
      )
      .get(saved.id) as { count: number };
    expect(itemAfter).toBeUndefined();
    expect(usageAfter.count).toBe(0);
    expect(mapAfter.count).toBe(0);
    dbAfter.close();
    expect(fs.existsSync(itemMirrorPath)).toBe(false);

    const storeAfter = new MemoryStore(sqlitePath);
    const indexer = new MemoryIndexer(memoryRoot.getLayout().root, storeAfter, {
      isEnabled: () => false,
      validateConfiguration: () => {},
      embedOne: async () => vector(0),
      embedMany: async () => [vector(0)],
    });
    await indexer.reindexStaleFilesAndWait();
    const resurrected = storeAfter.findItemByKey({
      scope: 'group',
      groupFolder: 'team',
      key: 'cleanup_target',
    });
    expect(resurrected).toBeNull();
    storeAfter.close();

    const checkpointsDir = path.join(
      memoryRoot.getLayout().journalDir,
      'checkpoints',
    );
    const checkpointFiles = fs
      .readdirSync(checkpointsDir)
      .filter((name) => name.endsWith('.db'));
    expect(checkpointFiles.length).toBeGreaterThan(0);
  });

  it('keeps deleted rows when mirror deletion fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cleanup-'));
    tempRoots.push(root);
    MemoryRootService.setRootForTests(path.join(root, 'memory'));
    const memoryRoot = MemoryRootService.getInstance();
    const sqlitePath = memoryRoot.getSqliteCachePath();
    const itemMirrorPath = path.join(
      memoryRoot.getLayout().itemsDir,
      'fact',
      'mirror-failure.md',
    );
    fs.mkdirSync(path.dirname(itemMirrorPath), { recursive: true });
    fs.writeFileSync(itemMirrorPath, '# mirror\n', 'utf-8');

    const store = new MemoryStore(sqlitePath);
    const saved = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'mirror_failure',
      value: 'Should stay until mirror delete succeeds.',
      source: 'test',
      confidence: 0.8,
      source_folder: 'items',
      file_path: itemMirrorPath,
    });
    store.close();

    const dbBefore = new Database(sqlitePath);
    dbBefore
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1,
             deleted_at = datetime('now', '-365 days')
         WHERE id = ?`,
      )
      .run(saved.id);
    dbBefore.close();

    const realRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((target: fs.PathLike, options?: fs.RmOptions) => {
        if (path.resolve(String(target)) === path.resolve(itemMirrorPath)) {
          throw new Error('mirror delete failed');
        }
        return realRmSync(target, options);
      });

    const result = runMemoryCleanupOnce();
    rmSpy.mockRestore();

    expect(result.purgedItems).toBe(0);
    expect(result.mirrorErrors).toBeGreaterThanOrEqual(1);

    const dbAfter = new Database(sqlitePath);
    const row = dbAfter
      .prepare(
        `SELECT is_deleted, deleted_at FROM memory_items WHERE id = ? LIMIT 1`,
      )
      .get(saved.id) as { is_deleted: number; deleted_at: string | null };
    dbAfter.close();
    expect(row.is_deleted).toBe(1);
    expect(row.deleted_at).not.toBeNull();
    expect(fs.existsSync(itemMirrorPath)).toBe(true);
  });

  it('keeps deleted procedures when mirror deletion fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cleanup-'));
    tempRoots.push(root);
    MemoryRootService.setRootForTests(path.join(root, 'memory'));
    const memoryRoot = MemoryRootService.getInstance();
    const sqlitePath = memoryRoot.getSqliteCachePath();

    const store = new MemoryStore(sqlitePath);
    const saved = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Procedure mirror failure',
      body: '1. Step one\n2. Step two',
      tags: ['cleanup'],
      source: 'test',
      confidence: 0.9,
    });
    store.softDeleteProcedure(saved.id);
    store.close();

    const procedureMirrorPath = path.join(
      memoryRoot.getLayout().proceduresDir,
      `procedure-mirror-failure-${saved.id}.md`,
    );
    fs.mkdirSync(path.dirname(procedureMirrorPath), { recursive: true });
    fs.writeFileSync(procedureMirrorPath, '# procedure mirror\n', 'utf-8');

    const dbBefore = new Database(sqlitePath);
    dbBefore
      .prepare(
        `UPDATE memory_procedures
         SET deleted_at = datetime('now', '-365 days')
         WHERE id = ?`,
      )
      .run(saved.id);
    dbBefore.close();

    const realRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((target: fs.PathLike, options?: fs.RmOptions) => {
        if (
          path.resolve(String(target)) === path.resolve(procedureMirrorPath)
        ) {
          throw new Error('procedure mirror delete failed');
        }
        return realRmSync(target, options);
      });

    const result = runMemoryCleanupOnce();
    rmSpy.mockRestore();

    expect(result.purgedProcedures).toBe(0);
    expect(result.mirrorErrors).toBeGreaterThanOrEqual(1);

    const dbAfter = new Database(sqlitePath);
    const row = dbAfter
      .prepare(
        `SELECT is_deleted, deleted_at
         FROM memory_procedures
         WHERE id = ?
         LIMIT 1`,
      )
      .get(saved.id) as { is_deleted: number; deleted_at: string | null };
    dbAfter.close();

    expect(row.is_deleted).toBe(1);
    expect(row.deleted_at).not.toBeNull();
    expect(fs.existsSync(procedureMirrorPath)).toBe(true);
  });

  it('purges deleted procedures even when mirrors are already absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cleanup-'));
    tempRoots.push(root);
    MemoryRootService.setRootForTests(path.join(root, 'memory'));
    const memoryRoot = MemoryRootService.getInstance();
    const sqlitePath = memoryRoot.getSqliteCachePath();

    const store = new MemoryStore(sqlitePath);
    const saved = store.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Procedure missing mirror',
      body: '1. Step one\n2. Step two',
      tags: ['cleanup'],
      source: 'test',
      confidence: 0.9,
    });
    store.softDeleteProcedure(saved.id);
    store.close();

    const dbBefore = new Database(sqlitePath);
    dbBefore
      .prepare(
        `UPDATE memory_procedures
         SET deleted_at = datetime('now', '-365 days')
         WHERE id = ?`,
      )
      .run(saved.id);
    dbBefore.close();

    const result = runMemoryCleanupOnce();
    expect(result.purgedProcedures).toBe(1);

    const dbAfter = new Database(sqlitePath);
    const row = dbAfter
      .prepare(`SELECT id FROM memory_procedures WHERE id = ? LIMIT 1`)
      .get(saved.id);
    dbAfter.close();
    expect(row).toBeUndefined();
  });
});
