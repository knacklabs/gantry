import { afterEach, describe, expect, it, vi } from 'vitest';

function makeStorageRuntime() {
  return {
    service: {
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

async function loadRuntimeStore() {
  const runtime = makeStorageRuntime();
  vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
    createStorageRuntime: vi.fn(() => runtime),
  }));
  const module =
    await import('@core/adapters/storage/postgres/runtime-store.js');
  return { module, runtime };
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
