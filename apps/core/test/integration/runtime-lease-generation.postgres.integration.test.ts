import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  _setRuntimeStorageForTest,
  closeRuntimeStorage,
  tryAcquireRuntimeAdvisoryLease,
} from '@core/adapters/storage/postgres/runtime-store.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('runtime lease generation (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'lease_generation',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
  }, 60_000);

  afterAll(async () => {
    // Drop the schema while the pool is still alive; closeRuntimeStorage ends
    // the pool this harness owns (see PR #340).
    try {
      await runtime.cleanup();
    } finally {
      await closeRuntimeStorage().catch(() => undefined);
    }
  });

  it('issues strictly increasing generations from the real table', async () => {
    const first = await tryAcquireRuntimeAdvisoryLease('itest:gen-increasing');
    expect(first).toBeDefined();
    expect(first?.generation).toBe(1);
    await first?.release();

    const second = await tryAcquireRuntimeAdvisoryLease('itest:gen-increasing');
    expect(second?.generation).toBe(2);
    await second?.release();
  });

  it('persists the generation in runtime_lease_generations', async () => {
    const lease = await tryAcquireRuntimeAdvisoryLease('itest:gen-durable');
    await lease?.release();

    // Read the row back through the pool: this is the durability claim — the
    // value survives the lease, the connection, and would survive the process.
    const result = await runtime.service.pool.query<{
      generation: string;
      holder: string | null;
    }>(
      'SELECT generation, holder FROM runtime_lease_generations WHERE lease_key = $1',
      ['itest:gen-durable'],
    );
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].generation)).toBe(1);
    expect(result.rows[0].holder).toBe(`pid-${process.pid}`);

    // A later acquisition continues from the STORED value, not from zero.
    const again = await tryAcquireRuntimeAdvisoryLease('itest:gen-durable');
    expect(again?.generation).toBe(2);
    await again?.release();
  });

  it('keys generations per lease key', async () => {
    const a = await tryAcquireRuntimeAdvisoryLease('itest:gen-key-a');
    const b = await tryAcquireRuntimeAdvisoryLease('itest:gen-key-b');

    expect(a?.generation).toBe(1);
    expect(b?.generation).toBe(1);

    await a?.release();
    await b?.release();
  });

  it('does not hand a second holder the lease while it is held, and resumes after release', async () => {
    const held = await tryAcquireRuntimeAdvisoryLease('itest:gen-contended');
    expect(held?.generation).toBe(1);

    // Same process + same connection pool: pg advisory locks are
    // session-scoped, so a second acquisition takes a different connection and
    // must be refused while the first holds it.
    const contender = await tryAcquireRuntimeAdvisoryLease(
      'itest:gen-contended',
    );
    expect(contender).toBeUndefined();

    await held?.release();

    const successor = await tryAcquireRuntimeAdvisoryLease(
      'itest:gen-contended',
    );
    expect(successor).toBeDefined();
    // The refused attempt must NOT have consumed a generation.
    expect(successor?.generation).toBe(2);
    await successor?.release();
  });
});
