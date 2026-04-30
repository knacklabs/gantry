import { describe, expect, it, vi } from 'vitest';

import { CanonicalJobOpsService } from '@core/adapters/storage/postgres/services/canonical-job-ops-service.js';
import type { PostgresCanonicalJobRepository } from '@core/adapters/storage/postgres/repositories/canonical-job-repository.postgres.js';

describe('CanonicalJobOpsService', () => {
  it('uses the runtime event app id for run-scoped event queries', async () => {
    const repository = {
      findRuntimeEventAppIdForRun: vi.fn(async () => 'app-two'),
      findRunById: vi.fn(),
      findJobById: vi.fn(),
      listEvents: vi.fn(async () => []),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.listRecentJobEvents(25, { run_id: 'run-2' });

    expect(repository.findRuntimeEventAppIdForRun).toHaveBeenCalledWith(
      'run-2',
    );
    expect(repository.listEvents).toHaveBeenCalledWith(
      25,
      expect.objectContaining({
        appId: 'app-two',
        runId: 'run-2',
      }),
    );
  });
});
