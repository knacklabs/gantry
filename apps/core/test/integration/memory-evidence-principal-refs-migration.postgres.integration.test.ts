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
  return `memory_principal_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

const migration = fs.readFileSync(
  path.resolve(
    'apps/core/src/adapters/storage/postgres/schema/migrations/20260908053355_memory_evidence_principal_refs.sql',
  ),
  'utf8',
);

maybeDescribe('memory evidence principal reference migration', () => {
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

  it('converts evidence and embedded demotion provenance without losing legacy sources', async () => {
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
        CREATE TABLE memory_evidence (
          app_id text NOT NULL,
          actor_id text
        );
        CREATE TABLE memory_items (
          app_id text NOT NULL,
          source_ref_json jsonb NOT NULL
        );
        INSERT INTO users (id, app_id, kind, agent_id) VALUES
          ('person:owner', 'app:one', 'human', NULL),
          ('person:agent', 'app:one', 'service', 'agent:main');
        INSERT INTO user_aliases (id, app_id, user_id)
          VALUES ('alias:owner', 'app:one', 'person:owner');
        INSERT INTO memory_evidence (app_id, actor_id) VALUES
          ('app:one', 'person:owner'),
          ('app:one', 'alias:owner'),
          ('app:one', 'agent:main'),
          ('app:one', 'mcp-tool');
        INSERT INTO memory_items (app_id, source_ref_json) VALUES
          ('app:one', '{"demoted_by":"alias:owner"}'),
          ('app:one', '{"demoted_by":"legacy-import"}');
      `);

      await client.query(migration);

      const evidence = await client.query<{ actor_id: string }>(
        'SELECT actor_id FROM memory_evidence ORDER BY actor_id',
      );
      expect(evidence.rows.map((row) => JSON.parse(row.actor_id))).toEqual(
        expect.arrayContaining([
          { kind: 'human', personId: 'person:owner' },
          { kind: 'human', personId: 'person:owner', aliasId: 'alias:owner' },
          { kind: 'service', personId: 'person:agent' },
          { kind: 'system', source: 'mcp-tool' },
        ]),
      );
      const items = await client.query<{ source_ref_json: unknown }>(
        "SELECT source_ref_json FROM memory_items ORDER BY source_ref_json ->> 'demoted_by'",
      );
      expect(items.rows.map((row) => row.source_ref_json)).toEqual(
        expect.arrayContaining([
          {
            demoted_by: {
              kind: 'human',
              personId: 'person:owner',
              aliasId: 'alias:owner',
            },
          },
          { demoted_by: { kind: 'system', source: 'legacy-import' } },
        ]),
      );
    } finally {
      client.release();
    }
  });
});
