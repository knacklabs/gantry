import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresRunPermissionOriginRepository } from '@core/adapters/storage/postgres/repositories/run-permission-origin-repository.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import type { RunPermissionOrigin } from '@core/domain/ports/run-permission-origin.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('run_permission_origin Postgres', () => {
  let service: PostgresStorageService;
  let repository: PostgresRunPermissionOriginRepository;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `run_permission_origin_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    repository = new PostgresRunPermissionOriginRepository(service.db);
  });

  afterAll(async () => {
    if (service) {
      await service.pool.query(
        `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
      );
      await service.close();
    }
  });

  it('upserts and reads a run origin by run id', async () => {
    const origin = {
      runId: 'run-origin-1',
      appId: 'default',
      agentFolder: 'main',
      targetJid: 'conversation:1',
      providerAccountId: 'account:1',
      threadId: 'thread:1',
      triggeringSenderId: 'sender:1',
      senderIsApprover: false,
      triggeringMessageTimestamp: '2026-07-13T05:00:00.000Z',
      triggeringMessageId: 'message:1',
      isScheduled: false,
      createdAt: '2026-07-13T05:00:01.000Z',
    } satisfies RunPermissionOrigin;

    await repository.upsertRunOrigin(origin);
    await expect(repository.getRunOrigin(origin.runId)).resolves.toEqual(
      origin,
    );

    await repository.upsertRunOrigin({ ...origin, senderIsApprover: true });
    await expect(repository.getRunOrigin(origin.runId)).resolves.toEqual({
      ...origin,
      senderIsApprover: true,
    });
  });
});
