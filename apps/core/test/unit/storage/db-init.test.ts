import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-db-init-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock('@core/core/config.js');
});

describe('storage db initDatabase', () => {
  it('rejects postgres storage until runtime persistence is provider-backed', async () => {
    const runtimeRoot = createTempDir();
    const sqlitePath = path.join(runtimeRoot, 'store', 'postgres-runtime.db');
    vi.doMock('@core/core/config.js', () => ({
      STORAGE_PROVIDER: 'postgres',
      STORAGE_SQLITE_PATH: sqlitePath,
    }));

    const dbModule = await import('@core/storage/db.js');
    expect(() => dbModule.initDatabase()).toThrow(
      /storage\.provider=postgres is not available/i,
    );
    expect(fs.existsSync(sqlitePath)).toBe(false);
  });

  it('initializes sqlite database at storage.sqlite.path', async () => {
    const runtimeRoot = createTempDir();
    const sqlitePath = path.join(runtimeRoot, 'store', 'custom.db');

    vi.doMock('@core/core/config.js', () => ({
      STORAGE_PROVIDER: 'sqlite',
      STORAGE_SQLITE_PATH: sqlitePath,
    }));

    const dbModule = await import('@core/storage/db.js');
    dbModule.initDatabase();

    expect(fs.existsSync(sqlitePath)).toBe(true);
    dbModule._closeDatabase();
  });
});
