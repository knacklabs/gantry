import fs from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stableId } from '@core/adapters/storage/postgres/repositories/person-identity-mappers.postgres.js';

import { hasPostgresIntegrationDatabase } from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeSchemaName(): string {
  return `agent_service_person_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

maybeDescribe('agent service-person identity migration', () => {
  let pool: Pool;
  let schemaName: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.GANTRY_TEST_DATABASE_URL });
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

  it('backfills each existing agent as the same stable service Person used at runtime', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      await client.query(`
        CREATE TABLE users (
          id text PRIMARY KEY,
          app_id text NOT NULL,
          kind text NOT NULL DEFAULT 'human',
          display_name text,
          status text NOT NULL DEFAULT 'active',
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE TABLE agents (
          id text PRIMARY KEY,
          app_id text NOT NULL,
          name text NOT NULL,
          status text NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        INSERT INTO agents (
          id, app_id, name, status, created_at, updated_at
        ) VALUES (
          'agent:legacy', 'app:legacy', 'Legacy support', 'active',
          '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z'
        );
      `);

      const migration = fs.readFileSync(
        path.resolve(
          'apps/core/src/adapters/storage/postgres/schema/migrations/20260907065511_agent_service_person_identity.sql',
        ),
        'utf8',
      );
      await client.query(migration);

      const people = await client.query<{
        id: string;
        agent_id: string;
        kind: string;
        display_name: string;
        status: string;
      }>(
        `SELECT id, agent_id, kind, display_name, status
         FROM users
         WHERE agent_id = 'agent:legacy'`,
      );
      expect(people.rows).toEqual([
        {
          id: stableId('person', ['app:legacy', 'service', 'agent:legacy']),
          agent_id: 'agent:legacy',
          kind: 'service',
          display_name: 'Legacy support',
          status: 'active',
        },
      ]);
      await expect(
        client.query(
          `INSERT INTO users (
             id, app_id, kind, status, created_at, updated_at
           ) VALUES (
             'person:invalid-service', 'app:legacy', 'service', 'active', now(), now()
           )`,
        ),
      ).rejects.toThrow('users_service_agent_kind_check');
    } finally {
      client.release();
    }
  });
});
