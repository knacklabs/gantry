import { describe, expect, it } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
  RuntimeDependencyStatus,
  StaleRuntimeDependencyLister,
  UpdateRuntimeDependencyStatusInput,
} from '@core/domain/ports/fleet-capability-state.js';
import type { ToolchainBakeNotifier } from '@core/jobs/toolchain-bake-executor.js';
import {
  ToolchainBakeReaper,
  bakeReapStalenessMs,
  resetToolchainBakeForRequeue,
} from '@core/jobs/toolchain-bake-reaper.js';

const NOW_MS = Date.parse('2026-06-11T12:00:00.000Z');
const STALENESS_MS = bakeReapStalenessMs(); // 15 min default

type ReaperRepo = RuntimeDependencyRepository & StaleRuntimeDependencyLister;

function fakeRepo(rows: RuntimeDependency[]): ReaperRepo & {
  rows: Map<string, RuntimeDependency>;
} {
  const map = new Map(rows.map((row) => [row.id, row]));
  return {
    rows: map,
    createRuntimeDependency: async () => {
      throw new Error('unused');
    },
    getRuntimeDependency: async (id) => map.get(id) ?? null,
    getRuntimeDependencyByManifestHash: async () => null,
    listRuntimeDependencies: async () => [...map.values()],
    listStaleRuntimeDependencies: async (input: {
      statuses: RuntimeDependencyStatus[];
      updatedBefore: string;
    }) =>
      [...map.values()].filter(
        (row) =>
          input.statuses.includes(row.status) &&
          row.updatedAt < input.updatedBefore,
      ),
    updateRuntimeDependencyStatus: async (
      input: UpdateRuntimeDependencyStatusInput,
    ) => {
      const row = map.get(input.id);
      if (!row) return false;
      if (input.fromStatus !== undefined) {
        const from = Array.isArray(input.fromStatus)
          ? input.fromStatus
          : [input.fromStatus];
        if (!from.includes(row.status)) return false;
      }
      row.status = input.status;
      if (input.failureReason !== undefined) {
        row.failureReason = input.failureReason;
      }
      // Mirror the Postgres repo: every status write bumps updatedAt.
      row.updatedAt = input.now ?? new Date(NOW_MS).toISOString();
      return true;
    },
  };
}

function recordingQueue(): {
  enqueued: Array<{ dependencyId: string; manifestHash: string }>;
  enqueueBake: (input: {
    dependencyId: string;
    manifestHash: string;
  }) => Promise<void>;
} {
  const enqueued: Array<{ dependencyId: string; manifestHash: string }> = [];
  return {
    enqueued,
    enqueueBake: async (input) => {
      enqueued.push(input);
    },
  };
}

function recordingNotifier(): ToolchainBakeNotifier & {
  notifications: Array<{ manifestHash: string; status: string }>;
} {
  const notifications: Array<{ manifestHash: string; status: string }> = [];
  return {
    notifications,
    notifyManifestChanged: async (input) => {
      notifications.push({
        manifestHash: input.manifestHash,
        status: input.status,
      });
    },
  };
}

function row(
  overrides: Partial<RuntimeDependency> & { id: string },
): RuntimeDependency {
  return {
    appId: 'default',
    manifestHash: `sha256:${overrides.id}`,
    requestedPackages: ['left-pad@1.3.0'],
    status: 'baking',
    artifact: null,
    failureReason: null,
    requestedByAgentId: null,
    approvedByConversationId: null,
    approvedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

function staleIso(): string {
  return new Date(NOW_MS - STALENESS_MS - 60_000).toISOString();
}

function freshIso(): string {
  return new Date(NOW_MS - 30_000).toISOString();
}

describe('resetToolchainBakeForRequeue', () => {
  it('resets a stale baking row to queued, re-enqueues, and re-NOTIFYs', async () => {
    const repo = fakeRepo([row({ id: 'dep-1', updatedAt: staleIso() })]);
    const queue = recordingQueue();
    const notifier = recordingNotifier();

    const outcome = await resetToolchainBakeForRequeue(
      { runtimeDependencies: repo, queue, notifier },
      {
        dependency: repo.rows.get('dep-1')!,
        fromStatuses: ['queued', 'baking'],
        stalenessMs: STALENESS_MS,
        now: NOW_MS,
      },
    );

    expect(outcome).toBe('requeued');
    expect(repo.rows.get('dep-1')?.status).toBe('queued');
    expect(queue.enqueued).toEqual([
      { dependencyId: 'dep-1', manifestHash: 'sha256:dep-1' },
    ]);
    expect(notifier.notifications).toEqual([
      { manifestHash: 'sha256:dep-1', status: 'queued' },
    ]);
  });

  it('refuses to clobber a fresh baking row (in flight)', async () => {
    const repo = fakeRepo([row({ id: 'dep-1', updatedAt: freshIso() })]);
    const queue = recordingQueue();
    const notifier = recordingNotifier();

    const outcome = await resetToolchainBakeForRequeue(
      { runtimeDependencies: repo, queue, notifier },
      {
        dependency: repo.rows.get('dep-1')!,
        fromStatuses: ['queued', 'baking', 'failed'],
        stalenessMs: STALENESS_MS,
        now: NOW_MS,
      },
    );

    expect(outcome).toBe('in_flight');
    expect(repo.rows.get('dep-1')?.status).toBe('baking');
    expect(queue.enqueued).toHaveLength(0);
    expect(notifier.notifications).toHaveLength(0);
  });

  it('resets a failed row regardless of age (CLI rebake semantics)', async () => {
    const repo = fakeRepo([
      row({
        id: 'dep-1',
        status: 'failed',
        failureReason: 'npm install failed',
        updatedAt: freshIso(),
      }),
    ]);
    const queue = recordingQueue();

    const outcome = await resetToolchainBakeForRequeue(
      { runtimeDependencies: repo, queue, notifier: recordingNotifier() },
      {
        dependency: repo.rows.get('dep-1')!,
        fromStatuses: ['failed', 'baking'],
        stalenessMs: STALENESS_MS,
        now: NOW_MS,
      },
    );

    expect(outcome).toBe('requeued');
    expect(repo.rows.get('dep-1')?.status).toBe('queued');
    expect(repo.rows.get('dep-1')?.failureReason).toBeNull();
    expect(queue.enqueued).toHaveLength(1);
  });

  it('resets an uploaded row when the caller allows it (quarantine rebake semantics)', async () => {
    const repo = fakeRepo([
      row({ id: 'dep-1', status: 'uploaded', updatedAt: freshIso() }),
    ]);
    const queue = recordingQueue();

    const outcome = await resetToolchainBakeForRequeue(
      { runtimeDependencies: repo, queue, notifier: recordingNotifier() },
      {
        dependency: repo.rows.get('dep-1')!,
        fromStatuses: ['failed', 'uploaded', 'activated', 'baking', 'queued'],
        stalenessMs: STALENESS_MS,
        now: NOW_MS,
      },
    );

    expect(outcome).toBe('requeued');
    expect(repo.rows.get('dep-1')?.status).toBe('queued');
    expect(queue.enqueued).toHaveLength(1);
  });

  it('reports not_resettable for statuses outside the allowed set', async () => {
    const repo = fakeRepo([
      row({ id: 'dep-1', status: 'uploaded', updatedAt: staleIso() }),
    ]);
    const queue = recordingQueue();

    const outcome = await resetToolchainBakeForRequeue(
      { runtimeDependencies: repo, queue, notifier: recordingNotifier() },
      {
        dependency: repo.rows.get('dep-1')!,
        fromStatuses: ['failed', 'baking'],
        stalenessMs: STALENESS_MS,
        now: NOW_MS,
      },
    );

    expect(outcome).toBe('not_resettable');
    expect(queue.enqueued).toHaveLength(0);
  });

  it('reports lost_race when the guarded CAS finds a changed row, without enqueueing', async () => {
    const stale = row({ id: 'dep-1', updatedAt: staleIso() });
    const repo = fakeRepo([stale]);
    const queue = recordingQueue();
    // Caller read a stale snapshot; the live baker finished between that read
    // and the CAS (the stored row moved on while the snapshot still says baking).
    const snapshot = { ...stale };
    repo.rows.get('dep-1')!.status = 'uploaded';

    const outcome = await resetToolchainBakeForRequeue(
      { runtimeDependencies: repo, queue, notifier: recordingNotifier() },
      {
        dependency: snapshot,
        fromStatuses: ['queued', 'baking'],
        stalenessMs: STALENESS_MS,
        now: NOW_MS,
      },
    );

    expect(outcome).toBe('lost_race');
    expect(repo.rows.get('dep-1')?.status).toBe('uploaded');
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe('ToolchainBakeReaper', () => {
  it('reaps stale baking and queued rows, leaving fresh rows untouched', async () => {
    const repo = fakeRepo([
      row({ id: 'stale-baking', updatedAt: staleIso() }),
      row({ id: 'stale-queued', status: 'queued', updatedAt: staleIso() }),
      row({ id: 'fresh-baking', updatedAt: freshIso() }),
      row({ id: 'done', status: 'uploaded', updatedAt: staleIso() }),
    ]);
    const queue = recordingQueue();
    const notifier = recordingNotifier();
    const reaper = new ToolchainBakeReaper({
      runtimeDependencies: repo,
      queue,
      notifier,
      now: () => NOW_MS,
      setIntervalFn: (() => 0 as never) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    const result = await reaper.runOnce();

    expect(result).toEqual({ scanned: 2, requeued: 2 });
    expect(repo.rows.get('stale-baking')?.status).toBe('queued');
    expect(repo.rows.get('stale-queued')?.status).toBe('queued');
    expect(repo.rows.get('fresh-baking')?.status).toBe('baking');
    expect(repo.rows.get('done')?.status).toBe('uploaded');
    expect(queue.enqueued.map((e) => e.dependencyId).sort()).toEqual([
      'stale-baking',
      'stale-queued',
    ]);
    expect(notifier.notifications.map((n) => n.status)).toEqual([
      'queued',
      'queued',
    ]);
    // The reset bumped updatedAt, so the next pass does not re-reap them.
    const second = await reaper.runOnce();
    expect(second).toEqual({ scanned: 0, requeued: 0 });
  });

  it('starts an immediate pass and stops cleanly clearing its timer', async () => {
    const repo = fakeRepo([row({ id: 'stale-baking', updatedAt: staleIso() })]);
    const queue = recordingQueue();
    let intervalCleared = false;
    let scheduled: (() => void) | null = null;
    const reaper = new ToolchainBakeReaper({
      runtimeDependencies: repo,
      queue,
      notifier: recordingNotifier(),
      now: () => NOW_MS,
      setIntervalFn: ((fn: () => void) => {
        scheduled = fn;
        return 7 as never;
      }) as unknown as typeof setInterval,
      clearIntervalFn: ((handle: unknown) => {
        intervalCleared = handle === 7;
      }) as unknown as typeof clearInterval,
    });

    reaper.start();
    // start() kicks one pass immediately without waiting for the interval.
    await reaper.runOnce();
    expect(queue.enqueued).toHaveLength(1);
    expect(scheduled).toBeTypeOf('function');

    await reaper.stop();
    expect(intervalCleared).toBe(true);
  });

  it('continues past a row whose reset throws', async () => {
    const repo = fakeRepo([
      row({ id: 'bad', updatedAt: staleIso() }),
      row({ id: 'good', updatedAt: staleIso() }),
    ]);
    const queue = recordingQueue();
    const failingRepo: ReaperRepo = {
      ...repo,
      updateRuntimeDependencyStatus: async (input) => {
        if (input.id === 'bad') throw new Error('boom');
        return repo.updateRuntimeDependencyStatus(input);
      },
    };
    const reaper = new ToolchainBakeReaper({
      runtimeDependencies: failingRepo,
      queue,
      notifier: recordingNotifier(),
      now: () => NOW_MS,
      setIntervalFn: (() => 0 as never) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    const result = await reaper.runOnce();

    expect(result.scanned).toBe(2);
    expect(result.requeued).toBe(1);
    expect(queue.enqueued.map((e) => e.dependencyId)).toEqual(['good']);
  });
});
