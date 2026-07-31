import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeEnvFile } from '@core/config/env/file.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

/**
 * Stands in for the durable runtime_lease_generations table. Held OUTSIDE the
 * client so it survives `vi.resetModules()` + a fresh client, which is how the
 * durability test simulates a process restart: a process-local counter would
 * reset to 1 here and fail.
 */
function makeGenerationTable() {
  const rows = new Map<string, number>();
  return {
    rows,
    bump(leaseKey: string): number {
      const next = (rows.get(leaseKey) ?? 0) + 1;
      rows.set(leaseKey, next);
      return next;
    },
  };
}

type GenerationTable = ReturnType<typeof makeGenerationTable>;

function makeLeaseClient(
  generations: GenerationTable = makeGenerationTable(),
  options: { failGenerationBump?: boolean; generationRows?: unknown[] } = {},
) {
  return Object.assign(new EventEmitter(), {
    generations,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.includes('runtime_lease_generations')) {
        if (options.failGenerationBump) {
          throw new Error('generation bump failed');
        }
        if (options.generationRows) return { rows: options.generationRows };
        const leaseKey = String((params ?? [])[0]);
        // node-postgres returns bigint as a string; mirror that so the
        // production Number() conversion is exercised as written.
        return { rows: [{ generation: String(generations.bump(leaseKey)) }] };
      }
      return { rows: [] };
    }),
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
    liveTurnCommandWakeupSource: {
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
  const createStorageRuntime = vi.fn(() => runtime);
  vi.doMock(
    '@core/adapters/storage/postgres/factory.js',
    async (importOriginal) => ({
      ...(await importOriginal<
        typeof import('@core/adapters/storage/postgres/factory.js')
      >()),
      createStorageRuntime,
    }),
  );
  const module =
    await import('@core/adapters/storage/postgres/runtime-store.js');
  return { client, module, runtime, createStorageRuntime };
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

  it('reuses service-owned storage without closing it', async () => {
    const { module, runtime } = await loadRuntimeStore();
    module._setRuntimeStorageForTest(runtime as never);

    const lease = await module.acquireRuntimeStorage();
    expect(lease.storage).toBe(runtime);
    expect(lease.owned).toBe(false);

    await lease.release();

    expect(runtime.runtimeEventNotifier.close).not.toHaveBeenCalled();
    expect(runtime.liveAdmissionWakeupSource.close).not.toHaveBeenCalled();
    expect(runtime.liveTurnCommandWakeupSource.close).not.toHaveBeenCalled();
    expect(runtime.service.close).not.toHaveBeenCalled();
  });

  it('rejects an explicit runtime home when service-owned storage scope is unknown', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-service-mismatch-'),
    );
    const settings = createDefaultRuntimeSettings();
    settings.storage.postgres.urlEnv =
      'GANTRY_RUNTIME_STORE_SERVICE_MISMATCH_URL';
    writeEnvFile(path.join(runtimeHome, '.env'), {
      GANTRY_RUNTIME_STORE_SERVICE_MISMATCH_URL:
        'postgresql://other:other@localhost/other',
    });
    const { module, runtime } = await loadRuntimeStore();
    module._setRuntimeStorageForTest(runtime as never);

    try {
      await expect(
        module.acquireRuntimeStorageForRuntimeHome(runtimeHome, settings),
      ).rejects.toThrow(
        'Runtime storage is already initialized for a different runtime home',
      );
      expect(runtime.service.close).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('reuses service-owned storage when its explicit runtime-home scope matches', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-service-match-'),
    );
    const settings = createDefaultRuntimeSettings();
    settings.storage.postgres.urlEnv = 'GANTRY_RUNTIME_STORE_SERVICE_MATCH_URL';
    const postgresUrl = 'postgresql://same:same@localhost/same_service';
    writeEnvFile(path.join(runtimeHome, '.env'), {
      GANTRY_RUNTIME_STORE_SERVICE_MATCH_URL: postgresUrl,
    });
    const { module, runtime } = await loadRuntimeStore();

    try {
      await module.initializeRuntimeStorage({
        runtimeHome,
        runtimeSettings: settings,
        storageConfig: {
          postgresUrl,
          postgresUrlEnv: settings.storage.postgres.urlEnv,
          postgresSchema: settings.storage.postgres.schema,
        },
      } as never);

      const lease = await module.acquireRuntimeStorageForRuntimeHome(
        runtimeHome,
        settings,
      );

      expect(lease.storage).toBe(runtime);
      expect(lease.owned).toBe(false);
      await lease.release();
      expect(runtime.service.close).not.toHaveBeenCalled();
    } finally {
      await module.closeRuntimeStorage();
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('closes every owned storage resource exactly once', async () => {
    const { module, runtime } = await loadRuntimeStore();

    const lease = await module.acquireRuntimeStorage();
    expect(lease.owned).toBe(true);

    await lease.release();
    await lease.release();

    expect(runtime.runtimeEventNotifier.close).toHaveBeenCalledOnce();
    expect(runtime.liveAdmissionWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.liveTurnCommandWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.service.close).toHaveBeenCalledOnce();
    expect(() => module.getRuntimeStorage()).toThrow(
      'Runtime storage has not been initialized',
    );
  });

  it('shares one command-owned runtime until every lease is released', async () => {
    const { module, runtime } = await loadRuntimeStore();

    const [first, second] = await Promise.all([
      module.acquireRuntimeStorage(),
      module.acquireRuntimeStorage(),
    ]);

    expect(first.storage).toBe(runtime);
    expect(second.storage).toBe(runtime);
    expect(runtime.service.assertMigrationsCurrent).toHaveBeenCalledOnce();

    await first.release();
    expect(runtime.service.close).not.toHaveBeenCalled();

    await second.release();
    expect(runtime.service.close).toHaveBeenCalledOnce();
  });

  it('shares a scoped runtime for concurrent acquisitions of the same home', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-same-home-'),
    );
    const settings = createDefaultRuntimeSettings();
    settings.storage.postgres.urlEnv = 'GANTRY_RUNTIME_STORE_SAME_HOME_URL';
    writeEnvFile(path.join(runtimeHome, '.env'), {
      GANTRY_RUNTIME_STORE_SAME_HOME_URL:
        'postgresql://same:same@localhost/same',
    });
    const { module, runtime, createStorageRuntime } = await loadRuntimeStore();

    try {
      const [first, second] = await Promise.all([
        module.acquireRuntimeStorageForRuntimeHome(runtimeHome, settings),
        module.acquireRuntimeStorageForRuntimeHome(runtimeHome, settings),
      ]);

      expect(first.storage).toBe(runtime);
      expect(second.storage).toBe(runtime);
      expect(createStorageRuntime).toHaveBeenCalledOnce();

      await first.release();
      expect(runtime.service.close).not.toHaveBeenCalled();
      await second.release();
      expect(runtime.service.close).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('propagates one shared initialization failure to same-scope waiters', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-shared-failure-'),
    );
    const settings = createDefaultRuntimeSettings();
    settings.storage.postgres.urlEnv =
      'GANTRY_RUNTIME_STORE_SHARED_FAILURE_URL';
    writeEnvFile(path.join(runtimeHome, '.env'), {
      GANTRY_RUNTIME_STORE_SHARED_FAILURE_URL:
        'postgresql://fail:fail@localhost/fail',
    });
    const { module, runtime, createStorageRuntime } = await loadRuntimeStore();
    const initializationError = new Error('shared initialization failed');
    let rejectInitialization: ((error: Error) => void) | undefined;
    runtime.service.assertMigrationsCurrent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInitialization = reject;
        }),
    );

    try {
      const first = module.acquireRuntimeStorageForRuntimeHome(
        runtimeHome,
        settings,
      );
      const second = module.acquireRuntimeStorageForRuntimeHome(
        runtimeHome,
        settings,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      rejectInitialization?.(initializationError);

      const results = await Promise.allSettled([first, second]);

      expect(results).toEqual([
        { status: 'rejected', reason: initializationError },
        { status: 'rejected', reason: initializationError },
      ]);
      expect(createStorageRuntime).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('serializes different runtime homes instead of sharing credential storage', async () => {
    const firstHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-first-home-'),
    );
    const secondHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-second-home-'),
    );
    const firstSettings = createDefaultRuntimeSettings();
    const secondSettings = createDefaultRuntimeSettings();
    firstSettings.storage.postgres.urlEnv =
      'GANTRY_RUNTIME_STORE_FIRST_HOME_URL';
    secondSettings.storage.postgres.urlEnv =
      'GANTRY_RUNTIME_STORE_SECOND_HOME_URL';
    writeEnvFile(path.join(firstHome, '.env'), {
      GANTRY_RUNTIME_STORE_FIRST_HOME_URL:
        'postgresql://first:first@localhost/first',
    });
    writeEnvFile(path.join(secondHome, '.env'), {
      GANTRY_RUNTIME_STORE_SECOND_HOME_URL:
        'postgresql://second:second@localhost/second',
    });
    const { module, runtime, createStorageRuntime } = await loadRuntimeStore();
    const secondRuntime = makeStorageRuntime();
    createStorageRuntime
      .mockImplementationOnce(() => runtime)
      .mockImplementationOnce(() => secondRuntime);

    try {
      const first = await module.acquireRuntimeStorageForRuntimeHome(
        firstHome,
        firstSettings,
      );
      let secondResolved = false;
      const secondPromise = module
        .acquireRuntimeStorageForRuntimeHome(secondHome, secondSettings)
        .then((lease) => {
          secondResolved = true;
          return lease;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(secondResolved).toBe(false);
      expect(createStorageRuntime).toHaveBeenCalledOnce();

      await first.release();
      const second = await secondPromise;

      expect(second.storage).toBe(secondRuntime);
      expect(second.storage).not.toBe(runtime);
      expect(createStorageRuntime).toHaveBeenCalledTimes(2);
      await second.release();
    } finally {
      fs.rmSync(firstHome, { recursive: true, force: true });
      fs.rmSync(secondHome, { recursive: true, force: true });
    }
  });

  it('keeps a closing owner fenced until every resource finishes closing', async () => {
    const firstHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-closing-first-'),
    );
    const secondHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-runtime-store-closing-second-'),
    );
    const firstSettings = createDefaultRuntimeSettings();
    const secondSettings = createDefaultRuntimeSettings();
    firstSettings.storage.postgres.urlEnv =
      'GANTRY_RUNTIME_STORE_CLOSING_FIRST_URL';
    secondSettings.storage.postgres.urlEnv =
      'GANTRY_RUNTIME_STORE_CLOSING_SECOND_URL';
    writeEnvFile(path.join(firstHome, '.env'), {
      GANTRY_RUNTIME_STORE_CLOSING_FIRST_URL:
        'postgresql://first:first@localhost/closing_first',
    });
    writeEnvFile(path.join(secondHome, '.env'), {
      GANTRY_RUNTIME_STORE_CLOSING_SECOND_URL:
        'postgresql://second:second@localhost/closing_second',
    });
    const { module, runtime, createStorageRuntime } = await loadRuntimeStore();
    const secondRuntime = makeStorageRuntime();
    createStorageRuntime
      .mockImplementationOnce(() => runtime)
      .mockImplementationOnce(() => secondRuntime);
    let finishClose: (() => void) | undefined;
    runtime.service.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );

    try {
      const first = await module.acquireRuntimeStorageForRuntimeHome(
        firstHome,
        firstSettings,
      );
      const releasePromise = first.release();
      await vi.waitFor(() => {
        expect(runtime.service.close).toHaveBeenCalledOnce();
      });

      let secondResolved = false;
      const secondPromise = module
        .acquireRuntimeStorageForRuntimeHome(secondHome, secondSettings)
        .then((lease) => {
          secondResolved = true;
          return lease;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(secondResolved).toBe(false);
      expect(createStorageRuntime).toHaveBeenCalledOnce();

      finishClose?.();
      await releasePromise;
      const second = await secondPromise;
      expect(second.storage).toBe(secondRuntime);
      expect(createStorageRuntime).toHaveBeenCalledTimes(2);
      await second.release();
    } finally {
      finishClose?.();
      fs.rmSync(firstHome, { recursive: true, force: true });
      fs.rmSync(secondHome, { recursive: true, force: true });
    }
  });

  it('waits for lease-driven closure instead of closing resources twice', async () => {
    const { module, runtime } = await loadRuntimeStore();
    let finishClose: (() => void) | undefined;
    runtime.service.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const lease = await module.acquireRuntimeStorage();
    const releasePromise = lease.release();
    await vi.waitFor(() => {
      expect(runtime.service.close).toHaveBeenCalledOnce();
    });
    expect(() => module.getRuntimeStorage()).toThrow(
      'Runtime storage has not been initialized',
    );

    let shutdownResolved = false;
    const shutdownPromise = module.closeRuntimeStorage().then(() => {
      shutdownResolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdownResolved).toBe(false);
    expect(runtime.liveTurnCommandWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.liveAdmissionWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.runtimeEventNotifier.close).toHaveBeenCalledOnce();
    expect(runtime.service.close).toHaveBeenCalledOnce();

    finishClose?.();
    await Promise.all([releasePromise, shutdownPromise]);
    expect(runtime.service.close).toHaveBeenCalledOnce();
  });

  it('reports lease-driven close failures to concurrent shutdown callers', async () => {
    const { module, runtime } = await loadRuntimeStore();
    let failClose: ((error: Error) => void) | undefined;
    runtime.service.close.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failClose = reject;
        }),
    );
    const lease = await module.acquireRuntimeStorage();
    const releasePromise = lease.release();
    const releaseFailure = expect(releasePromise).rejects.toThrow(
      'service close failed',
    );
    await vi.waitFor(() => {
      expect(runtime.service.close).toHaveBeenCalledOnce();
    });
    const shutdownFailure = expect(
      module.closeRuntimeStorage(),
    ).rejects.toThrow('service close failed');

    failClose?.(new Error('service close failed'));
    await Promise.all([releaseFailure, shutdownFailure]);
    expect(runtime.service.close).toHaveBeenCalledOnce();
  });

  it('closes its owned runtime without touching its replacement', async () => {
    const { module, runtime } = await loadRuntimeStore();
    const lease = await module.acquireRuntimeStorage();
    const replacement = makeStorageRuntime();
    module._setRuntimeStorageForTest(replacement as never);

    await lease.release();

    expect(runtime.runtimeEventNotifier.close).toHaveBeenCalledOnce();
    expect(runtime.liveAdmissionWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.liveTurnCommandWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.service.close).toHaveBeenCalledOnce();
    expect(replacement.service.close).not.toHaveBeenCalled();
    expect(module.getRuntimeStorage()).toBe(replacement);
  });

  it('does not double-close when canonical shutdown wins active command leases', async () => {
    const { module, runtime } = await loadRuntimeStore();
    const [first, second] = await Promise.all([
      module.acquireRuntimeStorage(),
      module.acquireRuntimeStorage(),
    ]);

    await module.closeRuntimeStorage();
    await first.release();
    await second.release();

    expect(runtime.liveTurnCommandWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.liveAdmissionWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.runtimeEventNotifier.close).toHaveBeenCalledOnce();
    expect(runtime.service.close).toHaveBeenCalledOnce();
    expect(() => module.getRuntimeStorage()).toThrow(
      'Runtime storage has not been initialized',
    );
  });

  it('attempts every owned resource close before surfacing failures', async () => {
    const { module, runtime } = await loadRuntimeStore();
    runtime.liveTurnCommandWakeupSource.close.mockRejectedValueOnce(
      new Error('turn wakeup close failed'),
    );
    runtime.liveAdmissionWakeupSource.close.mockRejectedValueOnce(
      new Error('admission wakeup close failed'),
    );
    const lease = await module.acquireRuntimeStorage();

    await expect(lease.release()).rejects.toBeInstanceOf(AggregateError);

    expect(runtime.liveTurnCommandWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.liveAdmissionWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.runtimeEventNotifier.close).toHaveBeenCalledOnce();
    expect(runtime.service.close).toHaveBeenCalledOnce();
  });

  it('attempts every resource close when initialization fails', async () => {
    const { module, runtime } = await loadRuntimeStore();
    runtime.service.assertMigrationsCurrent.mockRejectedValueOnce(
      new Error('migration check failed'),
    );

    await expect(module.initializeRuntimeStorage()).rejects.toThrow(
      'migration check failed',
    );

    expect(runtime.liveTurnCommandWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.liveAdmissionWakeupSource.close).toHaveBeenCalledOnce();
    expect(runtime.runtimeEventNotifier.close).toHaveBeenCalledOnce();
    expect(runtime.service.close).toHaveBeenCalledOnce();
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
    // lock + generation bump + unlock
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('issues a strictly increasing generation per lease key', async () => {
    const generations = makeGenerationTable();
    const { module } = await loadRuntimeStore(makeLeaseClient(generations));
    await module.initializeRuntimeStorage();

    const first = await module.tryAcquireRuntimeAdvisoryLease('runtime:gen');
    await first?.release();
    const second = await module.tryAcquireRuntimeAdvisoryLease('runtime:gen');
    await second?.release();

    expect(first?.generation).toBe(1);
    expect(second?.generation).toBe(2);
    expect(second!.generation).toBeGreaterThan(first!.generation);
  });

  it('keeps the generation increasing across a process restart', async () => {
    // The generation table outlives the module + client, exactly as the real
    // table outlives a process. A process-local counter would restart at 1.
    const generations = makeGenerationTable();
    const before = await loadRuntimeStore(makeLeaseClient(generations));
    await before.module.initializeRuntimeStorage();
    const first =
      await before.module.tryAcquireRuntimeAdvisoryLease('runtime:restart');
    await first?.release();

    vi.resetModules();
    const after = await loadRuntimeStore(makeLeaseClient(generations));
    await after.module.initializeRuntimeStorage();
    const second =
      await after.module.tryAcquireRuntimeAdvisoryLease('runtime:restart');

    expect(first?.generation).toBe(1);
    expect(second?.generation).toBe(2);
  });

  it('tracks generations separately per lease key', async () => {
    const generations = makeGenerationTable();
    const { module } = await loadRuntimeStore(makeLeaseClient(generations));
    await module.initializeRuntimeStorage();

    const a = await module.tryAcquireRuntimeAdvisoryLease('runtime:key-a');
    const b = await module.tryAcquireRuntimeAdvisoryLease('runtime:key-b');

    expect(a?.generation).toBe(1);
    expect(b?.generation).toBe(1);
  });

  it('fails closed and releases the connection when the generation bump throws', async () => {
    const client = makeLeaseClient(makeGenerationTable(), {
      failGenerationBump: true,
    });
    const { module } = await loadRuntimeStore(client);
    await module.initializeRuntimeStorage();

    await expect(
      module.tryAcquireRuntimeAdvisoryLease('runtime:bump-throws'),
    ).rejects.toThrow('generation bump failed');
    // The connection must go back to the pool, which drops the advisory lock —
    // The connection must be DESTROYED, not just returned to the pool: pg
    // advisory locks are session-scoped, so a plain release() hands a still-
    // locked session back and wedges the key for every other session.
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('destroys the connection even when the bump throws a non-Error', async () => {
    // A plain release() here would return a session that still holds the lock.
    const client = makeLeaseClient(makeGenerationTable());
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.includes('runtime_lease_generations')) throw 'not-an-error';
      return { rows: [] };
    });
    const { module } = await loadRuntimeStore(client);
    await module.initializeRuntimeStorage();

    await expect(
      module.tryAcquireRuntimeAdvisoryLease('runtime:bump-non-error'),
    ).rejects.toBe('not-an-error');
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('fails closed rather than issuing an unfenced lease when the bump returns no row', async () => {
    const client = makeLeaseClient(makeGenerationTable(), {
      generationRows: [],
    });
    const { module } = await loadRuntimeStore(client);
    await module.initializeRuntimeStorage();

    await expect(
      module.tryAcquireRuntimeAdvisoryLease('runtime:bump-empty'),
    ).rejects.toThrow('no usable generation');
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('destroys the connection when the lock query itself throws', async () => {
    // The lock may already have been taken server-side before a cancellation or
    // result-delivery failure, so "the query threw" does not mean "no lock".
    // Returning that session to the pool would strand an untracked lock.
    const client = makeLeaseClient(makeGenerationTable());
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        throw new Error('connection terminated during lock');
      }
      return { rows: [] };
    });
    const { module } = await loadRuntimeStore(client);
    await module.initializeRuntimeStorage();

    await expect(
      module.tryAcquireRuntimeAdvisoryLease('runtime:lock-throws'),
    ).rejects.toThrow('connection terminated during lock');
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('returns the connection WITHOUT destroying it when the lock itself is refused', async () => {
    // No lock was taken, so there is nothing to drop — destroying here would
    // churn pool connections on ordinary contention.
    const client = makeLeaseClient(makeGenerationTable());
    client.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory_lock')
        ? { rows: [{ acquired: false }] }
        : { rows: [] },
    );
    const { module } = await loadRuntimeStore(client);
    await module.initializeRuntimeStorage();

    await expect(
      module.tryAcquireRuntimeAdvisoryLease('runtime:refused'),
    ).resolves.toBeUndefined();
    expect(client.release).toHaveBeenCalledWith();
  });

  it('still permits the next acquisition after a normal release', async () => {
    // RACE-4 shipped a permanent-launch-block twice from fail-closed guards.
    const generations = makeGenerationTable();
    const { module } = await loadRuntimeStore(makeLeaseClient(generations));
    await module.initializeRuntimeStorage();

    const first =
      await module.tryAcquireRuntimeAdvisoryLease('runtime:reacquire');
    await first?.release();
    const second =
      await module.tryAcquireRuntimeAdvisoryLease('runtime:reacquire');

    expect(second).toBeDefined();
    expect(second?.isValid()).toBe(true);
  });
});
