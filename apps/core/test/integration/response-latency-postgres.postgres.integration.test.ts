import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import {
  classifyPostgresEvidenceAvailability,
  measurePostgresOperations,
} from '../harness/response-latency-postgres.js';

describe('Postgres response-latency evidence gate', () => {
  it('classifies missing database configuration as blocked evidence', () => {
    expect(classifyPostgresEvidenceAvailability({})).toEqual({
      status: 'blocked',
      blocker: 'missing_gantry_test_database_url',
    });
    expect(
      classifyPostgresEvidenceAvailability({
        GANTRY_TEST_DATABASE_URL: '   ',
      }),
    ).toEqual({
      status: 'blocked',
      blocker: 'missing_gantry_test_database_url',
    });
  });
});

describe.runIf(hasPostgresIntegrationDatabase)(
  'Postgres response-latency operation counting',
  () => {
    let runtime: PostgresIntegrationRuntime;

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'response_latency',
      });
    }, 60_000);

    afterAll(async () => {
      await runtime?.cleanup();
    });

    it('counts pool and checked-out-client statements plus outer transactions', async () => {
      const measurement = await measurePostgresOperations(
        runtime.service.pool,
        async () => {
          await runtime.service.pool.query('SELECT 1');
          const client = await runtime.service.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query({ text: 'SELECT 2' });
            await client.query('SAVEPOINT response_latency_probe');
            await client.query('RELEASE SAVEPOINT response_latency_probe');
            await client.query('COMMIT');
          } finally {
            client.release();
          }
          return { completed: true };
        },
      );

      expect(measurement).toEqual({
        counts: {
          postgres_statements: 2,
          postgres_transactions: 1,
        },
      });
      expect(measurement).not.toHaveProperty('sql');
    });

    it('counts START TRANSACTION once and ignores its control statements', async () => {
      const measurement = await measurePostgresOperations(
        runtime.service.pool,
        async () => {
          const client = await runtime.service.pool.connect();
          try {
            await client.query(
              '/* outer /* nested */ comment */ START TRANSACTION',
            );
            await client.query('SELECT 3');
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        },
      );

      expect(measurement.counts).toEqual({
        postgres_statements: 1,
        postgres_transactions: 1,
      });
    });

    it('rejects overlapping measurements and restores patches after failure', async () => {
      const originalConnect = runtime.service.pool.connect;
      let releaseOperation: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const operationStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const operationReleased = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });

      const firstMeasurement = measurePostgresOperations(
        runtime.service.pool,
        async () => {
          markStarted?.();
          await operationReleased;
        },
      );
      await operationStarted;

      await expect(
        measurePostgresOperations(runtime.service.pool, async () => undefined),
      ).rejects.toThrow('already being measured');
      await runtime.service.pool.query('SELECT 4');
      releaseOperation?.();
      const firstResult = await firstMeasurement;
      expect(firstResult.counts).toEqual({
        postgres_statements: 0,
        postgres_transactions: 0,
      });
      expect(runtime.service.pool.connect).toBe(originalConnect);

      await expect(
        measurePostgresOperations(runtime.service.pool, async () => {
          throw new Error('measurement failed');
        }),
      ).rejects.toThrow('measurement failed');
      expect(runtime.service.pool.connect).toBe(originalConnect);

      const checkedOut = await runtime.service.pool.connect();
      try {
        await expect(
          measurePostgresOperations(
            runtime.service.pool,
            async () => undefined,
          ),
        ).rejects.toThrow('must be idle');
      } finally {
        checkedOut.release();
      }
    });

    it('removes the isolated schema during cleanup', async () => {
      const isolated = await createPostgresIntegrationRuntime({
        schemaPrefix: 'response_latency_cleanup',
      });
      const schemaName = isolated.schemaName;

      try {
        const beforeCleanup = await runtime.service.pool.query<{
          present: boolean;
        }>(
          'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present',
          [schemaName],
        );
        expect(beforeCleanup.rows[0]?.present).toBe(true);
      } finally {
        await isolated.cleanup();
      }

      const afterCleanup = await runtime.service.pool.query<{
        present: boolean;
      }>(
        'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present',
        [schemaName],
      );
      expect(afterCleanup.rows[0]?.present).toBe(false);
    }, 60_000);
  },
);
