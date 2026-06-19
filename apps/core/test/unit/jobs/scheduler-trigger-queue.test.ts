import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `STORAGE_POSTGRES_URL` is a module-level config constant resolved at import
// time; mock it so the truth table can toggle the URL between cases.
const configMocks = vi.hoisted(() => ({
  url: 'postgres://example/db' as string | undefined,
  schema: 'gantry',
}));

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/config/index.js')>();
  return {
    ...actual,
    get STORAGE_POSTGRES_URL() {
      return configMocks.url;
    },
    get STORAGE_POSTGRES_SCHEMA() {
      return configMocks.schema;
    },
  };
});

// Fake engine so `startSchedulerLoop` can install a "running" engine without a
// real pg-boss connection. `isReady()` follows a controllable flag.
const engineMocks = vi.hoisted(() => ({
  ready: true,
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  enqueueSchedulerTriggerDelivery: vi.fn(async () => undefined),
  ensureSchedulerQueues: vi.fn(async () => undefined),
}));

vi.mock('@core/infrastructure/pgboss/scheduler-engine.js', () => ({
  PgBossSchedulerEngine: class {
    isReady() {
      return engineMocks.ready;
    }
    start = engineMocks.start;
    stop = engineMocks.stop;
    requestSync = vi.fn();
  },
  enqueueSchedulerTriggerDelivery: engineMocks.enqueueSchedulerTriggerDelivery,
  ensureSchedulerQueues: engineMocks.ensureSchedulerQueues,
}));

const runtimeStoreMocks = vi.hoisted(() => ({
  opsRepository: { getJobById: vi.fn() },
  controlRepository: {},
  workerCoordination: {},
  poolQuery: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeRepositories: () => runtimeStoreMocks.opsRepository,
  getRuntimeControlRepository: () => runtimeStoreMocks.controlRepository,
  getRuntimeEventExchange: () => ({ publish: vi.fn() }),
  getWorkerCoordinationRepository: () => runtimeStoreMocks.workerCoordination,
  getRuntimeStorage: () => ({
    service: {
      pool: {
        query: runtimeStoreMocks.poolQuery,
      },
    },
  }),
}));

const workerIdentityMocks = vi.hoisted(() => ({
  registerWorkerInstance: vi.fn(async () => 'worker-1'),
  stopWorkerHeartbeat: vi.fn(),
}));

vi.mock('@core/jobs/worker-identity.js', () => ({
  registerWorkerInstance: workerIdentityMocks.registerWorkerInstance,
  stopWorkerHeartbeat: workerIdentityMocks.stopWorkerHeartbeat,
}));

vi.mock('@core/jobs/concurrency.js', () => ({
  configureRunSlotBackend: vi.fn(),
  resetSchedulerRunSlots: vi.fn(),
}));

import {
  _hasQueuedLiveAdmissionWorkForTests,
  _resetSchedulerLoopForTests,
  _setSendOnlyPgBossFactoryForTests,
  enqueueJobTrigger,
  isJobTriggerQueueReady,
  markRoleHasNoJobExecution,
  startSchedulerLoop,
} from '@core/jobs/scheduler.js';

function makeDeps() {
  return {
    conversationRoutes: () => ({}),
    queue: {} as never,
    onProcess: vi.fn(),
    sendMessage: vi.fn(),
    opsRepository: runtimeStoreMocks.opsRepository as never,
  };
}

describe('isJobTriggerQueueReady truth table', () => {
  beforeEach(() => {
    _resetSchedulerLoopForTests();
    configMocks.url = 'postgres://example/db';
    engineMocks.ready = true;
    runtimeStoreMocks.poolQuery.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetSchedulerLoopForTests();
  });

  it('is ready when the scheduler engine is running', async () => {
    // A job-executing role with a running, ready engine.
    await startSchedulerLoop(makeDeps());
    expect(isJobTriggerQueueReady()).toBe(true);
  });

  it('is ready for a non-executing role when a Postgres URL is configured', () => {
    markRoleHasNoJobExecution();
    configMocks.url = 'postgres://example/db';
    expect(isJobTriggerQueueReady()).toBe(true);
  });

  it('is not ready for a non-executing role without a Postgres URL', () => {
    markRoleHasNoJobExecution();
    configMocks.url = undefined;
    expect(isJobTriggerQueueReady()).toBe(false);
  });

  it('is not ready for a default role with no running engine', () => {
    // Default role: roleHasNoJobExecution stays false, engine is null.
    expect(isJobTriggerQueueReady()).toBe(false);
  });

  it('counts queued and due-deferred live admission rows as interactive backlog', async () => {
    runtimeStoreMocks.poolQuery.mockResolvedValueOnce({
      rows: [{ waiting: true }],
    });

    await expect(_hasQueuedLiveAdmissionWorkForTests()).resolves.toBe(true);

    expect(String(runtimeStoreMocks.poolQuery.mock.calls[0]?.[0])).toContain(
      'defer_until IS NULL OR defer_until <= now()',
    );
  });
});

describe('enqueueJobTrigger from a non-executing role', () => {
  beforeEach(() => {
    _resetSchedulerLoopForTests();
    configMocks.url = 'postgres://example/db';
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetSchedulerLoopForTests();
    _setSendOnlyPgBossFactoryForTests(null);
  });

  it('starts, ensures queues, enqueues, then stops in order', async () => {
    markRoleHasNoJobExecution();
    const calls: string[] = [];
    const stop = vi.fn(async () => {
      calls.push('stop');
    });
    const start = vi.fn(async () => {
      calls.push('start');
    });
    const boss = { on: vi.fn(), start, stop } as never;
    _setSendOnlyPgBossFactoryForTests(() => boss);
    engineMocks.ensureSchedulerQueues.mockImplementation(async () => {
      calls.push('ensure');
    });
    engineMocks.enqueueSchedulerTriggerDelivery.mockImplementation(async () => {
      calls.push('enqueue');
    });

    await enqueueJobTrigger('job-1', 'trigger-1', { runId: 'run-1' });

    expect(calls).toEqual(['start', 'ensure', 'enqueue', 'stop']);
    expect(stop).toHaveBeenCalledWith({
      graceful: true,
      close: true,
      timeout: 10_000,
    });
    expect(engineMocks.enqueueSchedulerTriggerDelivery).toHaveBeenCalledWith({
      boss,
      opsRepository: runtimeStoreMocks.opsRepository,
      jobId: 'job-1',
      triggerId: 'trigger-1',
      runId: 'run-1',
    });
  });

  it('stops the client even when enqueue throws', async () => {
    markRoleHasNoJobExecution();
    const stop = vi.fn(async () => undefined);
    const boss = {
      on: vi.fn(),
      start: vi.fn(async () => undefined),
      stop,
    } as never;
    _setSendOnlyPgBossFactoryForTests(() => boss);
    engineMocks.ensureSchedulerQueues.mockResolvedValue(undefined);
    engineMocks.enqueueSchedulerTriggerDelivery.mockRejectedValueOnce(
      new Error('Job not found: job-1'),
    );

    await expect(enqueueJobTrigger('job-1', 'trigger-1')).rejects.toThrow(
      'Job not found: job-1',
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('throws before constructing a client when no Postgres URL is set', async () => {
    markRoleHasNoJobExecution();
    configMocks.url = undefined;
    const factory = vi.fn();
    _setSendOnlyPgBossFactoryForTests(factory as never);

    await expect(enqueueJobTrigger('job-1', 'trigger-1')).rejects.toThrow(
      'Postgres URL is required before enqueueing job triggers',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('throws for a default role with no engine and no non-executing flag', async () => {
    // Neither an engine nor the non-executing role flag: this is a real
    // mis-state, surfaced as a hard error rather than a silent send-only spin.
    const factory = vi.fn();
    _setSendOnlyPgBossFactoryForTests(factory as never);

    await expect(enqueueJobTrigger('job-1', 'trigger-1')).rejects.toThrow(
      'Scheduler engine is not running',
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
