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
  return `permission_principal_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

const migration = fs.readFileSync(
  path.resolve(
    'apps/core/src/adapters/storage/postgres/schema/migrations/20260908051309_permission_principal_refs.sql',
  ),
  'utf8',
);

maybeDescribe('permission principal reference migration', () => {
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

  it('maps authority decisions and audit values to principals while preserving system sources', async () => {
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
        CREATE TABLE conversation_approvers (
          app_id text NOT NULL,
          conversation_id text NOT NULL,
          person_id text,
          alias_id text,
          external_user_id text NOT NULL
        );
        CREATE TABLE permission_decisions (
          app_id text NOT NULL,
          approver_ref text,
          actor_context_json text
        );
        CREATE TABLE permission_audit_events (
          app_id text NOT NULL,
          actor_id text
        );
        INSERT INTO users (id, app_id, kind, agent_id) VALUES
          ('person:owner', 'app:one', 'human', NULL),
          ('person:agent', 'app:one', 'service', 'agent:main');
        INSERT INTO user_aliases (id, app_id, user_id)
          VALUES ('alias:owner', 'app:one', 'person:owner');
        INSERT INTO conversation_approvers (
          app_id, conversation_id, person_id, alias_id, external_user_id
        ) VALUES (
          'app:one', 'conversation:one', 'person:owner', 'alias:owner', 'U123'
        );
        INSERT INTO permission_decisions (
          app_id, approver_ref, actor_context_json
        ) VALUES
          ('app:one', 'U123', '{"conversationId":"conversation:one"}'),
          ('app:one', 'agent:main', NULL),
          ('app:one', 'runtime', NULL);
        INSERT INTO permission_audit_events (app_id, actor_id) VALUES
          ('app:one', 'alias:owner'),
          ('app:one', 'runtime');
      `);

      await client.query(migration);

      const decisions = await client.query<{ approver_ref: string }>(
        'SELECT approver_ref FROM permission_decisions ORDER BY approver_ref',
      );
      expect(decisions.rows.map((row) => JSON.parse(row.approver_ref))).toEqual(
        expect.arrayContaining([
          { kind: 'human', personId: 'person:owner', aliasId: 'alias:owner' },
          { kind: 'service', personId: 'person:agent' },
          { kind: 'system', source: 'runtime' },
        ]),
      );
      const audits = await client.query<{ actor_id: string }>(
        'SELECT actor_id FROM permission_audit_events ORDER BY actor_id',
      );
      expect(audits.rows.map((row) => JSON.parse(row.actor_id))).toEqual(
        expect.arrayContaining([
          { kind: 'human', personId: 'person:owner', aliasId: 'alias:owner' },
          { kind: 'system', source: 'runtime' },
        ]),
      );
    } finally {
      client.release();
    }
  });

  it('rejects an authority-bearing approval that cannot resolve to a Person', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query(`
        INSERT INTO permission_decisions (
          app_id, approver_ref, actor_context_json
        ) VALUES (
          'app:one', 'U-missing', '{"conversationId":"conversation:one"}'
        );
      `);

      await expect(client.query(migration)).rejects.toThrow(
        'permission principal migration requires every authority-bearing approver',
      );
    } finally {
      client.release();
    }
  });
});
