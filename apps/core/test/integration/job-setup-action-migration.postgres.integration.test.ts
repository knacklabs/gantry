import fs from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSetupState } from '@core/adapters/storage/postgres/services/canonical-job-target-state.js';
import type { JobSetupReadinessState } from '@core/domain/job-types.js';
import { stableSha256Json } from '@core/shared/stable-hash.js';
import { hasPostgresIntegrationDatabase } from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const LEGACY_ACTION_TEXT =
  'This job paused under the old format; resume to re-check.';
const NON_READY_STATES: Exclude<JobSetupReadinessState, 'ready'>[] = [
  'missing_capability',
  'broker_unreachable',
  'credential_unknown',
  'browser_login_may_be_required',
  'mcp_missing_credential',
];

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function makeSchemaName(): string {
  return `job_setup_action_${process.pid}_${Date.now()}_${Math.floor(
    Math.random() * 1_000_000,
  )}`.slice(0, 63);
}

maybeDescribe('tagged job setup action migration', () => {
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

  it('migrates every legacy non-ready state and marks its new fingerprint notified', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      await client.query(`
        CREATE TABLE jobs (
          id text PRIMARY KEY,
          setup_state jsonb,
          updated_at timestamptz NOT NULL
        )
      `);

      for (const state of [...NON_READY_STATES, 'unknown_legacy_state']) {
        await client.query(
          `INSERT INTO jobs (id, setup_state, updated_at) VALUES ($1, $2::jsonb, $3)`,
          [
            `job-${state}`,
            JSON.stringify({
              state,
              checkedAt: '2026-08-12T00:00:00.000Z',
              fingerprint: 'legacy-fingerprint',
              notifiedFingerprint: null,
              blockers: [
                {
                  requirementType: 'tool',
                  requirementId: 'Browser',
                  message: 'Legacy blocker',
                  nextAction: 'legacy recovery text',
                  grantable: true,
                },
              ],
            }),
            '2026-08-12T00:00:00.000Z',
          ],
        );
      }

      const migration = fs.readFileSync(
        path.resolve(
          'apps/core/src/adapters/storage/postgres/schema/migrations/20260813045311_tagged_setup_action_cutover.sql',
        ),
        'utf8',
      );
      await client.query(migration);

      const result = await client.query<{ id: string; setup_state: unknown }>(
        `SELECT id, setup_state FROM jobs ORDER BY id`,
      );
      expect(result.rows).toHaveLength(NON_READY_STATES.length + 1);

      for (const row of result.rows) {
        const expectedState = row.id.endsWith('unknown_legacy_state')
          ? 'broker_unreachable'
          : row.id.slice('job-'.length);
        const setupState = parseSetupState(row.setup_state, row.id)!;
        expect(setupState.state).toBe(expectedState);
        expect(setupState.notified_fingerprint).toBe(setupState.fingerprint);
        expect(setupState.blockers).toEqual([
          {
            state: expectedState,
            type: 'tool',
            id: 'legacy_setup_state',
            summary: 'This job paused under the old setup format.',
            action: { kind: 'instruction', text: LEGACY_ACTION_TEXT },
          },
        ]);
        expect(setupState.fingerprint).toBe(
          stableSha256Json({
            state: expectedState,
            blockers: [
              {
                state: expectedState,
                type: 'tool',
                id: 'legacy_setup_state',
                action: { kind: 'instruction', text: LEGACY_ACTION_TEXT },
              },
            ],
          }),
        );
      }
    } finally {
      client.release();
    }
  });
});
