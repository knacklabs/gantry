import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';
import type { AppId } from '@core/domain/app/app.js';

// Exercises the live SQL (migration + `expires_at > now()` count) against a
// real Postgres. Skipped unless GANTRY_TEST_DATABASE_URL is set.
const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

const appId = DEFAULT_APP_ID as AppId;
const DAY_MS = 24 * 60 * 60 * 1000;
const baseRequest = {
  appId,
  agentId: 'agent:test',
  requestedBy: 'folder:test',
  target: { id: 'capability:test' },
};

maybeDescribe('pending_access_requests Postgres', () => {
  let service: PostgresStorageService;
  let repositories: PostgresDomainRepositoryBundle;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `pending_access_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    repositories = createPostgresDomainRepositories(service.db, service.pool);
  });

  afterAll(async () => {
    if (service) {
      await service.pool.query(
        `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
      );
      await service.close();
    }
  });

  it('migration creates pending_access_requests with an expires_at column', async () => {
    const result = await service.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'pending_access_requests'`,
      [schemaName],
    );
    const columns = result.rows.map((row) => row.column_name as string);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'app_id',
        'agent_id',
        'requested_by',
        'target_json',
        'status',
        'created_at',
        'expires_at',
        'resolved_at',
      ]),
    );
  });

  it('counts only unexpired pending rows', async () => {
    const repo = repositories.pendingAccessRequests;

    // Future expires_at (the default 24h TTL) -> counts as pending.
    await repo.insertPending({ ...baseRequest, id: 'par_future' });
    expect(await repo.countPendingAccessRequests({ appId })).toBe(1);

    // Past expires_at (created 2 days ago -> expired 1 day ago) -> not counted.
    await repo.insertPending({
      ...baseRequest,
      id: 'par_expired',
      now: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });
    expect(await repo.countPendingAccessRequests({ appId })).toBe(1);

    // Approved -> not counted.
    await repo.insertPending({ ...baseRequest, id: 'par_approved' });
    await repo.markResolved({
      appId,
      id: 'par_approved',
      resolution: 'approved',
    });
    expect(await repo.countPendingAccessRequests({ appId })).toBe(1);

    // Denied -> not counted.
    await repo.insertPending({ ...baseRequest, id: 'par_denied' });
    await repo.markResolved({ appId, id: 'par_denied', resolution: 'denied' });
    expect(await repo.countPendingAccessRequests({ appId })).toBe(1);
  });
});
