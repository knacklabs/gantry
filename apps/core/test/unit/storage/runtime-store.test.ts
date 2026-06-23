import { afterEach, describe, expect, it, vi } from 'vitest';

const originalSkipRuntimeMigrations =
  process.env.GANTRY_SKIP_RUNTIME_MIGRATIONS;

function restoreEnv() {
  if (originalSkipRuntimeMigrations === undefined) {
    delete process.env.GANTRY_SKIP_RUNTIME_MIGRATIONS;
  } else {
    process.env.GANTRY_SKIP_RUNTIME_MIGRATIONS = originalSkipRuntimeMigrations;
  }
}

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
    restoreEnv();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('runs migrations before checking readiness by default', async () => {
    delete process.env.GANTRY_SKIP_RUNTIME_MIGRATIONS;
    const { module, runtime } = await loadRuntimeStore();

    await module.initializeRuntimeStorage();

    expect(runtime.service.migrate).toHaveBeenCalledOnce();
    expect(runtime.service.assertMigrationsCurrent).not.toHaveBeenCalled();
    expect(runtime.service.healthCheck).toHaveBeenCalledOnce();
  });

  it('checks migration head when runtime boot migrations are skipped', async () => {
    process.env.GANTRY_SKIP_RUNTIME_MIGRATIONS = '1';
    const { module, runtime } = await loadRuntimeStore();

    await module.initializeRuntimeStorage();

    expect(runtime.service.migrate).not.toHaveBeenCalled();
    expect(runtime.service.assertMigrationsCurrent).toHaveBeenCalledOnce();
    expect(runtime.service.healthCheck).toHaveBeenCalledOnce();
  });
});
