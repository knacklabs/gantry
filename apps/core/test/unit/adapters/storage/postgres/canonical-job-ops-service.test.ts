import { describe, expect, it, vi } from 'vitest';

import { CanonicalJobOpsService } from '@core/adapters/storage/postgres/services/canonical-job-ops-service.js';
import type { PostgresCanonicalJobRepository } from '@core/adapters/storage/postgres/repositories/canonical-job-repository.postgres.js';

describe('CanonicalJobOpsService', () => {
  it('persists job-scoped allowed tools under target capability policy', async () => {
    const repository = {
      findJobById: vi.fn(async () => null),
      upsertJob: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.upsertJob({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['tg:1'],
      group_scope: 'agent_one',
      capability_policy: {
        allowed_tools: ['Read', 'mcp__agent_browser__*'],
      },
    });

    const stored = vi.mocked(repository.upsertJob).mock.calls[0]?.[0] as {
      targetJson: string;
    };
    expect(JSON.parse(stored.targetJson).capabilityPolicy).toEqual({
      allowedTools: ['Read', 'mcp__agent_browser__*'],
    });
  });

  it('defaults missing capability policy to an empty allowed-tools list', async () => {
    const repository = {
      findJobById: vi.fn(async () => ({
        id: 'job-1',
        agentId: 'agent:agent_one',
        name: 'Job',
        prompt: 'Run',
        model: null,
        scheduleJson: JSON.stringify({ type: 'interval', value: '60000' }),
        status: 'active',
        executionMode: 'parallel',
        targetJson: JSON.stringify({
          linkedSessions: ['tg:1'],
          groupScope: 'agent_one',
        }),
        silent: false,
        timeoutMs: 300000,
        maxRetries: 3,
        retryBackoffMs: 5000,
        nextRunAt: null,
        lastRunAt: null,
        leaseRunId: null,
        leaseExpiresAt: null,
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      })),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await expect(service.getJobById('job-1')).resolves.toMatchObject({
      capability_policy: { allowed_tools: [] },
    });
  });

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
        ownerAppId: undefined,
        runId: 'run-2',
      }),
    );
  });

  it('passes app ownership filters to repository run and event queries', async () => {
    const repository = {
      listRuns: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.listJobRuns(undefined, 10, { ownerAppId: 'app-one' });
    await service.listRecentJobEvents(20, { owner_app_id: 'app-one' });

    expect(repository.listRuns).toHaveBeenCalledWith(undefined, 10, {
      ownerAppId: 'app-one',
    });
    expect(repository.listEvents).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        appId: undefined,
        ownerAppId: 'app-one',
      }),
    );
  });
});
