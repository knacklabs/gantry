import { describe, expect, it, vi } from 'vitest';

import { jsonb } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
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

function flattenSqlShape(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => flattenSqlShape(entry, seen)).join(' ');
  }
  const record = value as Record<string | symbol, unknown>;
  return [
    typeof record.value === 'string'
      ? record.value
      : flattenSqlShape(record.value, seen),
    typeof record.name === 'string' ? record.name : '',
    flattenSqlShape(record.queryChunks, seen),
    flattenSqlShape(record.config, seen),
  ].join(' ');
}

describe('PostgresCanonicalJobRepository', () => {
  it('fails loudly instead of storing invalid JSON strings in jsonb columns', () => {
    expect(() => jsonb('{not-json')).toThrow(
      'Invalid JSON string passed to jsonb column writer',
    );
  });

  it('marks stale lease runs as timed out when releasing job leases', async () => {
    const selectWhere = vi.fn(async () => [
      { id: 'job-1', leaseRunId: 'run-1' },
      { id: 'job-2', leaseRunId: null },
    ]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const updateWheres = [
      vi.fn(() => ({
        returning: vi.fn(async () => [{ id: 'job-1' }, { id: 'job-2' }]),
      })),
    ];
    const updateSets = [
      vi.fn(() => ({ where: updateWheres[0] })),
      vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 'run-1' }]),
        })),
      })),
      // run_leases fencing update for the released runs.
      vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    ];
    const tx = {
      select: vi.fn(() => ({ from: selectFrom })),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: updateSets[0] })
        .mockReturnValueOnce({ set: updateSets[1] })
        .mockReturnValueOnce({ set: updateSets[2] }),
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
        reason: 'lease_expired',
      },
      {
        jobId: 'job-2',
        runId: null,
        releasedAt: '2026-05-12T09:00:00.000Z',
        runTimedOut: false,
        reason: 'lease_expired',
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
    const releasePredicate = updateWheres[0].mock.calls[0]?.[0];
    expect(flattenSqlShape(releasePredicate)).toContain('status');
    expect(flattenSqlShape(releasePredicate)).toContain('lease_expires_at');
    expect(updateSets[1]).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'timeout',
        endedAt: '2026-05-12T09:00:00.000Z',
        errorSummary: 'Scheduler run lease expired before completion.',
      }),
    );
  });

  it('does not time out runs for stale leases changed before release update', async () => {
    const selectWhere = vi.fn(async () => [
      { id: 'job-1', leaseRunId: 'run-1' },
    ]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const jobReturning = vi.fn(async () => []);
    const jobWhere = vi.fn(() => ({ returning: jobReturning }));
    const jobSet = vi.fn(() => ({ where: jobWhere }));
    const tx = {
      select: vi.fn(() => ({ from: selectFrom })),
      update: vi.fn().mockReturnValueOnce({ set: jobSet }),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const repository = new PostgresCanonicalJobRepository(db as never);

    await expect(
      repository.releaseStaleLeases('2026-05-12T09:00:00.000Z'),
    ).resolves.toEqual([]);

    expect(jobReturning).toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalledTimes(1);
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
        workerInstanceId: 'worker-test',
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
    ).resolves.toBeNull();

    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('retries generated run short ids after a concurrent insert wins the same id', async () => {
    const graphSelectLimit = vi.fn(async () => [
      {
        agentId: 'agent:scheduler_agent',
        targetJson: JSON.stringify({
          executionContext: { workspaceKey: 'scheduler_agent' },
        }),
      },
    ]);
    const nextShortIdLimit = vi
      .fn()
      .mockResolvedValueOnce([{ nextShortId: 7 }])
      .mockResolvedValueOnce([{ nextShortId: 8 }]);
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: graphSelectLimit })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: nextShortIdLimit })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: nextShortIdLimit })),
        })),
      });
    const returning = vi
      .fn()
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'idx_agent_runs_job_short_id_unique',
      })
      .mockResolvedValueOnce([{ id: 'run-1' }]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { select, insert };
    const repository = new PostgresCanonicalJobRepository(db as never);
    (
      repository as unknown as {
        graph: { ensureAgentExists: typeof vi.fn };
      }
    ).graph = {
      ensureAgentExists: vi.fn(async () => 'agent:scheduler_agent'),
    };

    await expect(
      repository.insertRun({
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
      }),
    ).resolves.toBe(true);

    expect(returning).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ shortId: 7 }),
    );
    expect(values).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ shortId: 8 }),
    );
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
          workspaceKey: 'main_agent',
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
    const returning = vi.fn(async () => [{ id: 'run-1' }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };
    const repository = new PostgresCanonicalJobRepository(db as never);

    const result = await repository.markRunNotified(
      'run-1',
      '2026-05-12T10:00:00.000Z',
    );

    expect(set).toHaveBeenCalledWith({
      notifiedAt: '2026-05-12T10:00:00.000Z',
    });
    expect(where).toHaveBeenCalled();
    expect(returning).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('filters nested session agent runs out of scheduler run lists', async () => {
    const limit = vi.fn(async () => []);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const dynamic = vi.fn(() => ({ where, orderBy }));
    const from = vi.fn(() => ({ $dynamic: dynamic }));
    const db = { select: vi.fn(() => ({ from })) };
    const repository = new PostgresCanonicalJobRepository(db as never);

    await repository.listRuns('job-1');

    expect(where).toHaveBeenCalledTimes(1);
    const predicate = where.mock.calls[0]?.[0];
    const predicateShape = flattenSqlShape(predicate);
    expect(predicateShape).toContain('job_id');
    expect(predicateShape).toContain('session_id');
  });
});
