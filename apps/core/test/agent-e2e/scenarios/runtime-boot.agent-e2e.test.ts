import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
const maybeDescribe = hasDb ? describe : describe.skip;
const BOOT_TIMEOUT_MS = 300_000;

maybeDescribe('agent-e2e runtime boot (fresh state, hermetic)', () => {
  let harness: RuntimeHarness | undefined;
  let sawFailure = false;

  afterAll(async () => {
    await harness?.teardown({ failed: sawFailure });
  });

  it(
    'boots a fresh runtime healthy with current migrations',
    { timeout: BOOT_TIMEOUT_MS },
    async () => {
      try {
        harness = await startRuntimeHarness();

        const health = await fetch(`${harness.baseUrl}/healthz`);
        expect(health.status).toBe(200);

        const ready = await fetch(`${harness.baseUrl}/readyz`);
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({
          status: 'ready',
          checks: { database: 'pass', migrations: 'pass' },
        });

        const client = new Client({ connectionString: harness.databaseUrl });
        await client.connect();
        try {
          const applied = await client.query<{ applied: number }>(
            'SELECT count(*)::int AS applied FROM "gantry"."__drizzle_migrations"',
          );
          expect(applied.rows[0]?.applied).toBeGreaterThan(0);
        } finally {
          await client.end();
        }
      } catch (error) {
        sawFailure = true;
        throw error;
      }
    },
  );
});
