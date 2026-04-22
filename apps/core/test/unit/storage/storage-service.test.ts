import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStorageService } from '@core/storage/storage-service.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-storage-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('storage-service', () => {
  it('creates, migrates, and health-checks sqlite provider', async () => {
    const root = createTempDir();
    const sqlitePath = path.join(root, 'store', 'myclaw.db');

    const service = createStorageService({
      provider: 'sqlite',
      sqlitePath,
      postgresUrl: null,
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
      postgresSchema: 'myclaw',
    });
    await service.migrate();
    const health = await service.healthCheck();
    await service.close();

    expect(fs.existsSync(sqlitePath)).toBe(true);
    expect(health.lexicalSearch).toBe(true);
    expect(typeof health.vectorSearch).toBe('boolean');
  });

  it('throws for postgres provider when url is missing', () => {
    expect(() =>
      createStorageService({
        provider: 'postgres',
        sqlitePath: path.join(createTempDir(), 'store', 'myclaw.db'),
        postgresUrl: '',
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    ).toThrow(/MYCLAW_DATABASE_URL is not set/);
  });

  it('constructs postgres provider when url is present', async () => {
    const service = createStorageService({
      provider: 'postgres',
      sqlitePath: path.join(createTempDir(), 'store', 'myclaw.db'),
      postgresUrl: 'postgres://user:pass@127.0.0.1:5432/myclaw',
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
      postgresSchema: 'myclaw',
    });
    expect(service.provider).toBe('postgres');
    await service.close();
  });

  it('rejects postgres schema config that disagrees with runtime schema', () => {
    expect(() =>
      createStorageService({
        provider: 'postgres',
        sqlitePath: path.join(createTempDir(), 'store', 'myclaw.db'),
        postgresUrl: 'postgres://user:pass@127.0.0.1:5432/myclaw',
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'other_schema',
      }),
    ).toThrow(/storage\.postgres\.schema.*runtime schema/i);
  });

  it('rejects remote postgres urls without sslmode=require', () => {
    expect(() =>
      createStorageService({
        provider: 'postgres',
        sqlitePath: path.join(createTempDir(), 'store', 'myclaw.db'),
        postgresUrl: 'postgres://user:pass@db.example.com:5432/myclaw',
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    ).toThrow(/sslmode=require/i);
  });

  it('accepts remote postgres urls with sslmode=require', async () => {
    const service = createStorageService({
      provider: 'postgres',
      sqlitePath: path.join(createTempDir(), 'store', 'myclaw.db'),
      postgresUrl:
        'postgres://user:pass@db.example.com:5432/myclaw?sslmode=require',
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
      postgresSchema: 'myclaw',
    });
    expect(service.provider).toBe('postgres');
    await service.close();
  });
});
