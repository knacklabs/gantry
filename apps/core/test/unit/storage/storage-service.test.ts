import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@core/infrastructure/logging/logger.js';
import {
  PostgresStorageService,
  createStorageService,
  postgresMigrationsFolder,
} from '@core/adapters/storage/postgres/storage-service.js';

describe('storage-service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('points migrations at the packaged schema migrations directory', () => {
    expect(postgresMigrationsFolder).toMatch(/schema[/\\]migrations$/);
  });

  it('throws when postgres url is missing', () => {
    expect(() =>
      createStorageService({
        postgresUrl: '',
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      }),
    ).toThrow(/GANTRY_DATABASE_URL is required for runtime storage/);
  });

  it('constructs postgres storage when url is present', async () => {
    const service = createStorageService({
      postgresUrl: 'postgres://user:pass@127.0.0.1:5432/gantry',
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'gantry',
    });
    expect(service).toBeInstanceOf(PostgresStorageService);
    await service.close();
  });

  it('constructs postgres storage with custom runtime schema', async () => {
    const service = createStorageService({
      postgresUrl: 'postgres://user:pass@127.0.0.1:5432/gantry',
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'other_schema',
    });
    expect(service).toBeInstanceOf(PostgresStorageService);
    await service.close();
  });

  it('rejects remote postgres urls without sslmode=require', () => {
    expect(() =>
      createStorageService({
        postgresUrl: 'postgres://user:pass@db.example.com:5432/gantry',
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      }),
    ).toThrow(/sslmode=require/i);
  });

  it('accepts remote postgres urls with sslmode=require', async () => {
    const service = createStorageService({
      postgresUrl:
        'postgres://user:pass@db.example.com:5432/gantry?sslmode=require',
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'gantry',
    });
    expect(service).toBeInstanceOf(PostgresStorageService);
    await service.close();
  });

  it('handles idle postgres pool errors without throwing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const service = createStorageService({
      postgresUrl: 'postgres://user:pass@127.0.0.1:5432/gantry',
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'gantry',
    });

    expect(() => {
      service.pool.emit(
        'error',
        new Error('Connection terminated unexpectedly'),
      );
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Postgres pool idle client error',
    );

    await service.close();
  });
});
