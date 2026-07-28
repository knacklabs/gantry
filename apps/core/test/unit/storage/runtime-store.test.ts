import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

function makeLeaseClient() {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [],
    })),
    release: vi.fn(),
  });
}

function makeStorageRuntime(client = makeLeaseClient()) {
  return {
    service: {
      pool: {
        connect: vi.fn(async () => client),
      },
      migrate: vi.fn(async () => {}),
      assertMigrationsCurrent: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({
        lexicalSearch: true,
        vectorSearch: true,
        textSearch: true,
        jobQueue: true,
        runtimeEvents: true,
        eventBusOutbox: true,
      })),
      close: vi.fn(async () => {}),
    },
    ops: {},
    control: {},
    repositories: {
      workerCoordination: {},
      liveTurns: {},
    },
    runtimeEvents: {},
    runtimeEventNotifier: {
      close: vi.fn(async () => {}),
    },
    liveAdmissionWakeupSource: {
      subscribe: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    },
    fileArtifacts: {},
    skillArtifacts: {},
    browserProfileSnapshots: {},
  };
}

async function loadRuntimeStore(client = makeLeaseClient()) {
  const runtime = makeStorageRuntime(client);
  vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
    createStorageRuntime: vi.fn(() => runtime),
  }));
  const module =
    await import('@core/adapters/storage/postgres/runtime-store.js');
  return { client, module, runtime };
}

describe('initializeRuntimeStorage', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('checks migration head before checking readiness', async () => {
    const { module, runtime } = await loadRuntimeStore();

    await module.initializeRuntimeStorage();

    expect(runtime.service.migrate).not.toHaveBeenCalled();
    expect(runtime.service.assertMigrationsCurrent).toHaveBeenCalledOnce();
    expect(runtime.service.healthCheck).toHaveBeenCalledOnce();
  });
});

describe('tryAcquireRuntimeAdvisoryLease', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('invalidates on loss and replays the loss to a late subscriber', async () => {
    const lostError = new Error('lease connection lost');
    const { client, module } = await loadRuntimeStore();
    await module.initializeRuntimeStorage();
    const lease =
      await module.tryAcquireRuntimeAdvisoryLease('runtime:test-lease');

    expect(lease?.isValid()).toBe(true);
    client.emit('error', lostError);
    expect(lease?.isValid()).toBe(false);

    const onLateLoss = vi.fn();
    lease?.onLost?.(onLateLoss);

    expect(onLateLoss).toHaveBeenCalledOnce();
    expect(onLateLoss).toHaveBeenCalledWith(lostError);
  });

  it('invalidates on release and releases only once', async () => {
    const { client, module } = await loadRuntimeStore();
    await module.initializeRuntimeStorage();
    const lease =
      await module.tryAcquireRuntimeAdvisoryLease('runtime:test-lease');

    await lease?.release();
    await lease?.release();

    expect(lease?.isValid()).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
