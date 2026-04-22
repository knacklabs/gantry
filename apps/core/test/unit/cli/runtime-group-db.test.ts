import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRuntimeGroupDb } from '@core/cli/runtime-group-db.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/cli/runtime-settings.js';

const runtimeHomesToCleanup: string[] = [];

function createRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-runtime-group-db-test-'),
  );
  runtimeHomesToCleanup.push(runtimeHome);
  fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
  return runtimeHome;
}

afterEach(() => {
  for (const runtimeHome of runtimeHomesToCleanup.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('runtime-group-db', () => {
  it('uses storage.sqlite.path for registered group persistence', () => {
    const runtimeHome = createRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.storage.provider = 'sqlite';
    settings.storage.sqlite.path = 'store/custom/myclaw-groups.db';
    saveRuntimeSettings(runtimeHome, settings);

    const groupDb = openRuntimeGroupDb(runtimeHome);
    groupDb.setRegisteredGroup('tg:123', {
      name: 'Main',
      folder: 'main',
      trigger: '@myclaw',
      added_at: '2026-04-21T00:00:00.000Z',
    });
    groupDb.close();

    const sqlitePath = path.join(
      runtimeHome,
      'store',
      'custom',
      'myclaw-groups.db',
    );
    expect(fs.existsSync(sqlitePath)).toBe(true);

    const reopened = openRuntimeGroupDb(runtimeHome);
    expect(reopened.getAllRegisteredGroups()['tg:123']?.folder).toBe('main');
    reopened.close();
  });

  it('rejects postgres storage until runtime persistence is provider-backed', () => {
    const runtimeHome = createRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.storage.provider = 'postgres';
    settings.storage.sqlite.path = 'store/postgres-groups.db';
    settings.storage.postgres.urlEnv = 'MYCLAW_DATABASE_URL';
    saveRuntimeSettings(runtimeHome, settings);

    expect(() => openRuntimeGroupDb(runtimeHome)).toThrow(
      /storage\.provider=postgres is not available/i,
    );
  });

  it('rejects sqlite paths that escape runtime home', () => {
    const runtimeHome = createRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.storage.provider = 'sqlite';
    settings.storage.sqlite.path = '/tmp/myclaw-outside.db';
    saveRuntimeSettings(runtimeHome, settings);

    expect(() => openRuntimeGroupDb(runtimeHome)).toThrow(
      /storage\.sqlite\.path must resolve under runtime home/i,
    );
  });
});
