import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('generated identity primary-key repair', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'identity_repair',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('detects drift, repairs it, and leaves the repair unchanged on rerun', async () => {
    await runtime.service.pool.query(
      'ALTER TABLE message_parts ALTER COLUMN id DROP IDENTITY IF EXISTS',
    );

    const drifted = await runtime.service.healthCheck();
    expect(drifted.runtimeEvents).toBe(false);
    expect(drifted.runtimeEventsReason).toContain(
      'message_parts.id identity/default is missing',
    );

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0104_runtime_events_identity_repair.sql',
      ),
      'utf8',
    );
    await runtime.service.pool.query(migration);

    const repaired = await runtime.service.healthCheck();
    expect(repaired.runtimeEvents).toBe(true);
    expect(repaired.runtimeEventsReason).toBeUndefined();

    const sequenceAfterRepair = await runtime.service.pool.query<{
      sequence_oid: number | null;
    }>(
      "SELECT pg_get_serial_sequence('message_parts', 'id')::regclass::oid AS sequence_oid",
    );
    expect(sequenceAfterRepair.rows[0]?.sequence_oid).not.toBeNull();

    await runtime.service.pool.query(migration);

    const sequenceAfterRerun = await runtime.service.pool.query<{
      sequence_oid: number | null;
    }>(
      "SELECT pg_get_serial_sequence('message_parts', 'id')::regclass::oid AS sequence_oid",
    );
    expect(sequenceAfterRerun.rows[0]?.sequence_oid).toBe(
      sequenceAfterRepair.rows[0]?.sequence_oid,
    );
  });
});
