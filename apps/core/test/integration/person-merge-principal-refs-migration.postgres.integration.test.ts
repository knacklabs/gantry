import fs from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaName(): string {
  return `person_merge_principal_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

const migration = fs.readFileSync(
  path.resolve(
    'apps/core/src/adapters/storage/postgres/schema/migrations/20260908052708_person_merge_principal_refs.sql',
  ),
  'utf8',
);

maybeDescribe('person merge principal reference migration', () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.GANTRY_TEST_DATABASE_URL });
    schema = schemaName();
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  });

  afterAll(async () => {
    try {
      if (pool && schema) {
        await pool.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
        );
      }
    } finally {
      await pool?.end();
    }
  });

  it('converts Person, alias, Agent, and legacy-system merge actors', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query(`
        CREATE TABLE users (
          id text PRIMARY KEY,
          app_id text NOT NULL,
          kind text NOT NULL,
          agent_id text
        );
        CREATE TABLE user_aliases (
          id text PRIMARY KEY,
          app_id text NOT NULL,
          user_id text NOT NULL
        );
        CREATE TABLE person_merge_audit (
          app_id text NOT NULL,
          actor text NOT NULL
        );
        INSERT INTO users (id, app_id, kind, agent_id) VALUES
          ('person:owner', 'app:one', 'human', NULL),
          ('person:agent', 'app:one', 'service', 'agent:main');
        INSERT INTO user_aliases (id, app_id, user_id)
          VALUES ('alias:owner', 'app:one', 'person:owner');
        INSERT INTO person_merge_audit (app_id, actor) VALUES
          ('app:one', 'person:owner'),
          ('app:one', 'alias:owner'),
          ('app:one', 'agent:main'),
          ('app:one', 'legacy-import');
      `);

      await client.query(migration);

      const rows = await client.query<{ actor: string }>(
        'SELECT actor FROM person_merge_audit ORDER BY actor',
      );
      expect(rows.rows.map((row) => JSON.parse(row.actor))).toEqual(
        expect.arrayContaining([
          { kind: 'human', personId: 'person:owner' },
          { kind: 'human', personId: 'person:owner', aliasId: 'alias:owner' },
          { kind: 'service', personId: 'person:agent' },
          { kind: 'system', source: 'legacy-import' },
        ]),
      );
    } finally {
      client.release();
    }
  });
});
