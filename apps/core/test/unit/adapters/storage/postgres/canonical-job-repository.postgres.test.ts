import { describe, expect, it, vi } from 'vitest';

import { PostgresCanonicalJobRepository } from '@core/adapters/storage/postgres/repositories/canonical-job-repository.postgres.js';

function makeInsertOnlyDb() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => undefined),
      })),
    })),
  };
}

describe('PostgresCanonicalJobRepository', () => {
  it('marks stale lease runs as timed out when releasing job leases', async () => {
    const selectWhere = vi.fn(async () => [
      { id: 'job-1', leaseRunId: 'run-1' },
      { id: 'job-2', leaseRunId: null },
    ]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const updateWheres = [
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ];
    const updateSets = [
      vi.fn(() => ({ where: updateWheres[0] })),
      vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 'run-1' }]),
        })),
      })),
    ];
    const tx = {
      select: vi.fn(() => ({ from: selectFrom })),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: updateSets[0] })
        .mockReturnValueOnce({ set: updateSets[1] }),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const repository = new PostgresCanonicalJobRepository(db as never);

    await expect(
      repository.releaseStaleLeases('2026-05-12T09:00:00.000Z'),
    ).resolves.toEqual([
      {
        jobId: 'job-1',
        runId: 'run-1',
        releasedAt: '2026-05-12T09:00:00.000Z',
        runTimedOut: true,
      },
      {
        jobId: 'job-2',
        runId: null,
        releasedAt: '2026-05-12T09:00:00.000Z',
        runTimedOut: false,
      },
    ]);

    expect(updateSets[0]).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: '2026-05-12T09:00:00.000Z',
      }),
    );
    expect(updateSets[1]).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'timeout',
        endedAt: '2026-05-12T09:00:00.000Z',
        errorSummary: 'Scheduler run lease expired before completion.',
      }),
    );
  });

  it('does not claim a queued dispatch after the job is paused', async () => {
    const limit = vi.fn(async () => [
      {
        id: 'job-1',
        status: 'paused',
        nextRunAt: '2026-05-12T10:00:00.000Z',
      },
    ]);
    const forUpdate = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ for: forUpdate }));
    const from = vi.fn(() => ({ where }));
    const tx = {
      select: vi.fn(() => ({ from })),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const repository = new PostgresCanonicalJobRepository(db as never);

    await expect(
      repository.claimDueRunStart({
        jobId: 'job-1',
        leaseExpiresAt: '2026-05-12T10:05:00.000Z',
        run: {
          run_id: 'run-1',
          job_id: 'job-1',
          scheduled_for: '2026-05-12T10:00:00.000Z',
          started_at: '2026-05-12T10:00:00.000Z',
          ended_at: null,
          status: 'running',
          result_summary: null,
          error_summary: null,
          retry_count: 0,
          notified_at: null,
        },
      }),
    ).resolves.toBe(false);

    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('ensures job agents without overwriting the canonical agent display name', async () => {
    const db = makeInsertOnlyDb();
    const repository = new PostgresCanonicalJobRepository(db as never);
    const graph = {
      ensureAgentExists: vi.fn(async () => 'agent:main_agent'),
      ensureAgent: vi.fn(),
    };
    (
      repository as unknown as {
        graph: typeof graph;
      }
    ).graph = graph;

    await repository.upsertJob({
      id: 'system:dreaming:main_agent:tg-5759865942',
      agentId: 'agent:main_agent',
      name: 'Memory Dreaming (main_agent tg:5759865942)',
      prompt: 'Run memory dreaming',
      model: null,
      scheduleJson: JSON.stringify({ type: 'cron', value: '0 * * * *' }),
      status: 'active',
      targetJson: JSON.stringify({
        executionContext: {
          conversationJid: 'tg:5759865942',
          threadId: null,
          groupScope: 'main_agent',
          sessionId: null,
        },
      }),
      silent: true,
      timeoutMs: 300000,
      maxRetries: 3,
      retryBackoffMs: 5000,
      nextRunAt: null,
      lastRunAt: null,
      leaseRunId: null,
      leaseExpiresAt: null,
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:00.000Z',
    });

    expect(graph.ensureAgentExists).toHaveBeenCalledWith(
      'main_agent',
      'main_agent',
    );
    expect(graph.ensureAgent).not.toHaveBeenCalled();
  });

  it('persists run notification timestamps on canonical agent runs', async () => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };
    const repository = new PostgresCanonicalJobRepository(db as never);

    await repository.markRunNotified('run-1', '2026-05-12T10:00:00.000Z');

    expect(set).toHaveBeenCalledWith({
      notifiedAt: '2026-05-12T10:00:00.000Z',
    });
    expect(where).toHaveBeenCalled();
  });
});
