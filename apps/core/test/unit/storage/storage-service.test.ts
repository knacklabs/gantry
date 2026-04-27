import { describe, expect, it } from 'vitest';

import {
  PostgresStorageService,
  createStorageService,
  postgresMigrationsFolder,
} from '@core/adapters/storage/postgres/storage-service.js';

describe('storage-service', () => {
  it('points migrations at the packaged schema migrations directory', () => {
    expect(postgresMigrationsFolder).toMatch(/schema[/\\]migrations$/);
  });

  it('throws when postgres url is missing', () => {
    expect(() =>
      createStorageService({
        postgresUrl: '',
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    ).toThrow(/MYCLAW_DATABASE_URL is required for runtime storage/);
  });

  it('constructs postgres storage when url is present', async () => {
    const service = createStorageService({
      postgresUrl: 'postgres://user:pass@127.0.0.1:5432/myclaw',
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
      postgresSchema: 'myclaw',
    });
    expect(service).toBeInstanceOf(PostgresStorageService);
    await service.close();
  });

  it('constructs postgres storage with custom runtime schema', async () => {
    const service = createStorageService({
      postgresUrl: 'postgres://user:pass@127.0.0.1:5432/myclaw',
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
      postgresSchema: 'other_schema',
    });
    expect(service).toBeInstanceOf(PostgresStorageService);
    await service.close();
  });

  it('rejects remote postgres urls without sslmode=require', () => {
    expect(() =>
      createStorageService({
        postgresUrl: 'postgres://user:pass@db.example.com:5432/myclaw',
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    ).toThrow(/sslmode=require/i);
  });

  it('accepts remote postgres urls with sslmode=require', async () => {
    const service = createStorageService({
      postgresUrl:
        'postgres://user:pass@db.example.com:5432/myclaw?sslmode=require',
      postgresUrlEnv: 'MYCLAW_DATABASE_URL',
      postgresSchema: 'myclaw',
    });
    expect(service).toBeInstanceOf(PostgresStorageService);
    await service.close();
  });
});
