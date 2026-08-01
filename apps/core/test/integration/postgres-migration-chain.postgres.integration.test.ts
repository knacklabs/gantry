import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;
const journal = JSON.parse(
  fs.readFileSync(
    path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    ),
    'utf8',
  ),
) as { entries: unknown[] };

maybeDescribe('Postgres migration chain', () => {
  let service: PostgresStorageService;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `migration_chain_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
  });

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
    );
    await service.close();
  });

  it('applies every committed migration to a clean schema and is a no-op on rerun', async () => {
    const migrationTable = `${quotePostgresIdentifier(schemaName)}.${quotePostgresIdentifier('__drizzle_migrations')}`;
    const first = await service.pool.query<{ applied: string }>(
      `SELECT count(*)::text AS applied FROM ${migrationTable}`,
    );

    expect(Number(first.rows[0]?.applied)).toBe(journal.entries.length);

    await service.migrate();

    const second = await service.pool.query<{ applied: string }>(
      `SELECT count(*)::text AS applied FROM ${migrationTable}`,
    );
    expect(second.rows[0]?.applied).toBe(first.rows[0]?.applied);
  });
});
