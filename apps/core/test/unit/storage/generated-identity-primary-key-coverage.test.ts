import fs from 'node:fs';
import path from 'node:path';

import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS } from '@core/adapters/storage/postgres/storage-service.js';
import * as postgresSchema from '@core/adapters/storage/postgres/schema/schema.js';

function key(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

function schemaIdentityPrimaryKeys(): string[] {
  return Object.values(postgresSchema)
    .filter((value): value is PgTable => is(value, PgTable))
    .flatMap((table) => {
      const config = getTableConfig(table);
      // Drizzle stores inline `.primaryKey()` on column.primary, but
      // table-level `primaryKey({ columns })` in config.primaryKeys — an
      // identity column declared the second way would otherwise escape the
      // guard, leaving future coverage stale while this test stays green.
      const tableLevelPkColumns = new Set(
        config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
      );
      return config.columns
        .filter(
          (column) =>
            column.generatedIdentity?.type === 'always' &&
            (column.primary || tableLevelPkColumns.has(column.name)),
        )
        .map((column) => key(config.name, column.name));
    })
    .sort();
}

function migrationIdentityPrimaryKeys(): string[] {
  const migration = fs.readFileSync(
    path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/0104_runtime_events_identity_repair.sql',
    ),
    'utf8',
  );
  const values = migration.match(
    /FROM \(VALUES(?<values>[\s\S]*?)\) AS identity_primary_keys\(table_name, column_name\)/,
  )?.groups?.values;

  expect(values).toBeDefined();
  return [...(values ?? '').matchAll(/\('([^']+)',\s*'([^']+)'\)/g)]
    .map((match) => key(match[1]!, match[2]!))
    .sort();
}

describe('generated identity primary-key coverage', () => {
  it('covers every schema identity primary key in the repair migration and readiness probe', () => {
    const schemaKeys = schemaIdentityPrimaryKeys();
    const probeKeys = GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS.map((entry) =>
      key(entry.tableName, entry.columnName),
    ).sort();

    expect(migrationIdentityPrimaryKeys()).toEqual(schemaKeys);
    expect(probeKeys).toEqual(schemaKeys);
  });
});
