import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it, vi } from 'vitest';

import {
  GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS,
  PostgresStorageService,
  createStorageService,
  postgresMigrationsFolder,
  resolvePostgresPoolConfig,
} from '@core/adapters/storage/postgres/storage-service.js';
import {
  DEFAULT_SKILL_CATALOG,
  DEFAULT_TOOL_CATALOG,
} from '@core/adapters/storage/postgres/seeds.js';

describe('storage-service', () => {
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

  it('reserves enough pool headroom for listeners, leases, live turns, and jobs', () => {
    const config = resolvePostgresPoolConfig(
      'postgres://user:pass@127.0.0.1:5432/gantry',
      'gantry',
    );

    expect(config.max).toBeGreaterThanOrEqual(20);
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

  it('rejects docker compose postgres service hostname without an explicit plaintext allowlist', () => {
    expect(() =>
      createStorageService({
        postgresUrl: 'postgres://user:pass@postgres:5432/gantry',
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      }),
    ).toThrow(/sslmode=require/i);
  });

  it('accepts the first-party docker compose postgres service hostname when allowlisted', async () => {
    const service = createStorageService({
      postgresUrl: 'postgres://user:pass@postgres:5432/gantry',
      postgresUrlEnv: 'GANTRY_DATABASE_URL',
      postgresSchema: 'gantry',
      postgresPlaintextHostAllowlist: ['postgres'],
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

  it('accepts skipped runtime migrations only at the current migration head with seed data ready', async () => {
    const latest = readMigrationFiles({
      migrationsFolder: postgresMigrationsFolder,
    }).at(-1);
    expect(latest).toBeDefined();
    const service = new PostgresStorageService(
      'postgres://user:pass@127.0.0.1:5432/gantry',
      'gantry',
    );
    const query = vi
      .spyOn(service.pool, 'query')
      .mockImplementation(async (statement: unknown, params?: unknown[]) => {
        const sql = String(statement);
        if (sql.includes('__drizzle_migrations')) {
          expect(sql).toContain('WHERE created_at = $1 AND hash = $2');
          expect(params).toEqual([latest?.folderMillis, latest?.hash]);
          return { rows: [{ applied: 1 }] } as never;
        }
        expect(sql).toContain('tool_catalog');
        expect(params?.[8]).toBe(DEFAULT_TOOL_CATALOG.length);
        expect(params?.[10]).toBe(DEFAULT_SKILL_CATALOG.length);
        return { rows: [{ ready: true }] } as never;
      });

    await service.assertMigrationsCurrent();

    expect(query).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('rejects skipped runtime migrations before the current migration head', async () => {
    const service = new PostgresStorageService(
      'postgres://user:pass@127.0.0.1:5432/gantry',
      'gantry',
    );
    const query = vi.spyOn(service.pool, 'query').mockResolvedValue({
      rows: [],
    } as never);

    await expect(service.assertMigrationsCurrent()).rejects.toThrow(
      /Postgres schema migrations are not current/,
    );

    expect(query).toHaveBeenCalledOnce();
    await service.close();
  });

  it('fails readiness with the exact diagnostic when any identity primary key loses its generator', async () => {
    const service = new PostgresStorageService(
      'postgres://user:pass@127.0.0.1:5432/gantry',
      'gantry',
    );
    const query = vi
      .spyOn(service.pool, 'query')
      .mockImplementation(async (statement: unknown, params?: unknown[]) => {
        const sql = String(statement);
        if (sql === 'SELECT 1') {
          return { rows: [{}] } as never;
        }
        expect(sql).toContain('jsonb_to_recordset($2::jsonb)');
        expect(params?.[0]).toBe('gantry');
        expect(JSON.parse(String(params?.[1]))).toEqual(
          GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS,
        );
        return {
          rows: [
            {
              has_vector: true,
              has_text_search: true,
              has_job_queue: true,
              has_runtime_events_table: true,
              missing_generated_identity_primary_keys: ['message_parts.id'],
              has_event_bus_outbox_table: true,
              has_event_bus_outbox_runtime_event_unique: true,
              missing_runtime_event_indexes: [],
              missing_event_bus_outbox_indexes: [],
            },
          ],
        } as never;
      });

    const capabilities = await service.healthCheck();

    expect(capabilities.runtimeEvents).toBe(false);
    expect(capabilities.runtimeEventsReason).toBe(
      'message_parts.id identity/default is missing',
    );
    expect(query).toHaveBeenCalledTimes(2);
    await service.close();
  });
});
