import fs from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stableSha256Json } from '@core/shared/stable-hash.js';
import { hasPostgresIntegrationDatabase } from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeSchemaName(): string {
  return `capability_key_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

maybeDescribe('capability template canonical-key migration', () => {
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

  it('keeps the newest pending row per app and argv-free identity', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      await client.query(`
        CREATE TABLE capability_template_amendment_proposals (
          id text PRIMARY KEY,
          app_id text NOT NULL,
          capability_id text NOT NULL,
          canonical_key text NOT NULL,
          proposed_templates jsonb NOT NULL,
          status text NOT NULL,
          decided_by text,
          decision_reason text,
          decided_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX capability_template_amendment_proposals_canonical_unique
          ON capability_template_amendment_proposals (app_id, canonical_key)
          WHERE status = 'pending';
      `);
      const templates = ['/usr/local/bin/acme records get *'];
      await client.query(
        `INSERT INTO capability_template_amendment_proposals
           (id, app_id, capability_id, canonical_key, proposed_templates,
            status, created_at, updated_at)
         VALUES
           ('older', 'app-1', 'acme.records.read', 'argv-key-1', $1, 'pending', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'),
           ('newer', 'app-1', 'acme.records.read', 'argv-key-2', $1, 'pending', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z'),
           ('other-app', 'app-2', 'acme.records.read', 'argv-key-3', $1, 'pending', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
           ('terminal', 'app-1', 'acme.records.read', 'terminal-key', $1, 'approved', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z')`,
        [JSON.stringify(templates)],
      );

      const migration = fs.readFileSync(
        path.resolve(
          'apps/core/src/adapters/storage/postgres/schema/migrations/20260814060000_canonical_key_retirement.sql',
        ),
        'utf8',
      );
      await client.query(migration);

      const expectedKey = stableSha256Json({
        capabilityId: 'acme.records.read',
        proposedTemplates: templates,
      });
      const result = await client.query<{
        id: string;
        status: string;
        canonical_key: string;
        decided_by: string | null;
      }>(
        `SELECT id, status, canonical_key, decided_by
         FROM capability_template_amendment_proposals
         ORDER BY id`,
      );
      expect(result.rows).toEqual([
        {
          id: 'newer',
          status: 'pending',
          canonical_key: expectedKey,
          decided_by: null,
        },
        {
          id: 'older',
          status: 'denied',
          canonical_key: 'argv-key-1',
          decided_by: 'system:superseded',
        },
        {
          id: 'other-app',
          status: 'pending',
          canonical_key: expectedKey,
          decided_by: null,
        },
        {
          id: 'terminal',
          status: 'approved',
          canonical_key: 'terminal-key',
          decided_by: null,
        },
      ]);
    } finally {
      client.release();
    }
  });
});
