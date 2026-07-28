import fs from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasPostgresIntegrationDatabase } from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeSchemaName(): string {
  return `identity_memory_scope_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

maybeDescribe('identity memory scope cleanup migration', () => {
  let pool: Pool;
  let schemaName: string;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.GANTRY_TEST_DATABASE_URL,
    });
    schemaName = makeSchemaName();
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  });

  afterAll(async () => {
    try {
      if (pool && schemaName) {
        await pool.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
        );
      }
    } finally {
      await pool?.end();
    }
  });

  it('replays 0121 after clearing non-person memory user ids', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      await client.query(`
        CREATE TABLE users (
          app_id text NOT NULL,
          id text NOT NULL
        );
        CREATE TABLE conversation_participants (
          app_id text NOT NULL,
          user_id text NOT NULL
        );
        CREATE TABLE memory_items (
          id text NOT NULL,
          app_id text NOT NULL,
          subject_type text NOT NULL,
          user_id text
        );
        CREATE TABLE person_merge_audit (
          app_id text NOT NULL,
          source_person_id text NOT NULL,
          target_person_id text NOT NULL
        );
      `);
      await client.query(`
        INSERT INTO users (app_id, id)
        VALUES
          ('app-1', 'person-valid'),
          ('app-1', 'person-source'),
          ('app-1', 'person-target');
        INSERT INTO conversation_participants (app_id, user_id)
        VALUES ('app-1', 'person-valid');
        INSERT INTO person_merge_audit (
          app_id,
          source_person_id,
          target_person_id
        )
        VALUES ('app-1', 'person-source', 'person-target');
        INSERT INTO memory_items (id, app_id, subject_type, user_id)
        VALUES
          ('memory-user', 'app-1', 'user', 'person-valid'),
          ('memory-group', 'app-1', 'group', 'missing-group-user'),
          ('memory-channel', 'app-1', 'channel', 'missing-channel-user'),
          ('memory-common', 'app-1', 'common', 'missing-common-user');
      `);

      const migration = fs.readFileSync(
        path.resolve(
          'apps/core/src/adapters/storage/postgres/schema/migrations/0121_identity_app_scoped_person_foreign_keys.sql',
        ),
        'utf8',
      );
      await client.query(migration);

      const memory = await client.query<{
        id: string;
        user_id: string | null;
      }>(
        `SELECT id, user_id
         FROM memory_items
         ORDER BY id`,
      );
      expect(memory.rows).toEqual([
        { id: 'memory-channel', user_id: null },
        { id: 'memory-common', user_id: null },
        { id: 'memory-group', user_id: null },
        { id: 'memory-user', user_id: 'person-valid' },
      ]);

      const constraint = await client.query<{ convalidated: boolean }>(
        `SELECT convalidated
         FROM pg_constraint
         WHERE conname = 'memory_items_app_user_fk'`,
      );
      expect(constraint.rows).toEqual([{ convalidated: true }]);
    } finally {
      client.release();
    }
  });
});
