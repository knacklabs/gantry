import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsRevision } from '@core/domain/ports/fleet-capability-state.js';

const latest = vi.hoisted(() => ({ current: null as SettingsRevision | null }));
const loadState = vi.hoisted(() => ({
  markSettingsLoaded: vi.fn(),
  markSettingsNotLoaded: vi.fn(),
}));
const importMock = vi.hoisted(() => ({ importWorkstationSettings: vi.fn() }));
const log = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeBrowserProfileArtifactStore: () => ({}),
  getRuntimeBrowserProfileSnapshotRepository: () => ({}),
  getRuntimeStorage: () => ({
    ops: {},
    repositories: {
      settingsRevisions: {
        getLatestSettingsRevision: async () => latest.current,
      },
      runtimeDependencies: {},
      skills: {},
      workerCoordination: {},
    },
  }),
}));

const bakeMock = vi.hoisted(() => ({
  start: vi.fn(async () => ({}) as never),
  stop: vi.fn(async () => {}),
}));
vi.mock('@core/jobs/toolchain-bake-bootstrap.js', () => ({
  startToolchainBakeSubsystem: bakeMock.start,
  stopToolchainBakeSubsystem: bakeMock.stop,
}));

const reconcilerInstances = vi.hoisted(
  () => [] as Array<{ start: ReturnType<typeof vi.fn> }>,
);
vi.mock('@core/jobs/worker-capability-reconciler.js', () => ({
  WorkerCapabilityReconciler: class {
    start = vi.fn();
    stop = vi.fn(async () => {});
    constructor() {
      reconcilerInstances.push(this as never);
    }
  },
}));

const FakeWakeupSource = vi.hoisted(
  () =>
    class {
      subscribe(): () => void {
        return () => {};
      }
      async close(): Promise<void> {}
    },
);
vi.mock('@core/jobs/toolchain-manifest-listener.js', () => ({
  PostgresManifestWakeupSource: FakeWakeupSource,
}));
vi.mock('@core/config/settings/settings-revision-notify.js', () => ({
  PostgresSettingsRevisionWakeupSource: FakeWakeupSource,
}));
vi.mock('@core/jobs/worker-identity.js', () => ({
  currentWorkerInstanceId: () => 'worker-test',
}));

vi.mock('@core/runtime/settings-load-state.js', () => ({
  markSettingsLoaded: loadState.markSettingsLoaded,
  markSettingsNotLoaded: loadState.markSettingsNotLoaded,
  areSettingsLoaded: () => true,
}));

vi.mock('@core/config/settings/settings-import-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/config/settings/settings-import-service.js')
  >('@core/config/settings/settings-import-service.js');
  return {
    ...actual,
    importWorkstationSettings: importMock.importWorkstationSettings,
    settingsFromRevisionDocument: () => ({}) as never,
  };
});

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: log,
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: vi.fn(),
}));

import {
  buildBakeOutcomeNotice,
  prepareFleetSettings,
  startFleetSubsystems,
} from '@core/app/bootstrap/fleet-boot.js';
import type { RuntimeDependency } from '@core/domain/ports/fleet-capability-state.js';

function revisionRow(revision: number): SettingsRevision {
  return {
    appId: 'default',
    revision,
    settingsDocument: { agent: { name: 'Ada' } },
    minReaderVersion: 1,
    createdBy: 'cli',
    note: null,
    createdAt: '2026-06-11T00:00:00.000Z',
  };
}

const fakeApp = { loadState: async () => {} } as never;

function bakeDependency(
  overrides: Partial<RuntimeDependency> = {},
): RuntimeDependency {
  return {
    id: 'dep-1',
    appId: 'default',
    manifestHash: 'sha256:abc',
    requestedPackages: ['left-pad@1.3.0', 'pad-right@2.0.0'],
    status: 'uploaded',
    artifact: null,
    failureReason: null,
    requestedByAgentId: 'agent:main',
    approvedByConversationId: 'tg:approvals',
    approvedAt: '2026-06-11T00:00:00.000Z',
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('prepareFleetSettings', () => {
  beforeEach(() => {
    loadState.markSettingsLoaded.mockClear();
    loadState.markSettingsNotLoaded.mockClear();
    importMock.importWorkstationSettings.mockClear();
    log.warn.mockClear();
    log.info.mockClear();
    log.error.mockClear();
  });

  it('marks settings not loaded and logs the seed command when no revision exists', async () => {
    latest.current = null;
    const result = await prepareFleetSettings({
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      app: fakeApp,
    });

    expect(result).toEqual({ loaded: false, revision: null });
    expect(loadState.markSettingsNotLoaded).toHaveBeenCalledOnce();
    expect(loadState.markSettingsLoaded).not.toHaveBeenCalled();
    expect(importMock.importWorkstationSettings).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        seedCommand: 'gantry settings import --file settings.yaml',
      }),
      expect.stringContaining('gantry settings import --file settings.yaml'),
    );
  });

  it('applies the latest revision through the shared import path and marks loaded', async () => {
    latest.current = {
      appId: 'default',
      revision: 9,
      settingsDocument: { agent: { name: 'Ada' } },
      minReaderVersion: 1,
      createdBy: 'cli',
      note: null,
      createdAt: '2026-06-11T00:00:00.000Z',
    };
    const result = await prepareFleetSettings({
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      app: fakeApp,
    });

    expect(result).toEqual({ loaded: true, revision: 9 });
    expect(importMock.importWorkstationSettings).toHaveBeenCalledOnce();
    expect(loadState.markSettingsLoaded).toHaveBeenCalledOnce();
  });

  it('holds a boot revision that requires a newer settings reader', async () => {
    latest.current = {
      appId: 'default',
      revision: 10,
      settingsDocument: { agent: { name: 'Ada' } },
      minReaderVersion: 999,
      createdBy: 'cli',
      note: null,
      createdAt: '2026-06-11T00:00:00.000Z',
    };

    const result = await prepareFleetSettings({
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      app: fakeApp,
    });

    expect(result).toEqual({ loaded: false, revision: 10 });
    expect(loadState.markSettingsNotLoaded).toHaveBeenCalledOnce();
    expect(loadState.markSettingsLoaded).not.toHaveBeenCalled();
    expect(importMock.importWorkstationSettings).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 10,
        minReaderVersion: 999,
        readerVersion: expect.any(Number),
      }),
      expect.stringContaining('requires a newer reader version'),
    );
  });
});

describe('buildBakeOutcomeNotice', () => {
  beforeEach(() => {
    log.warn.mockClear();
  });

  it('sends one concise success notice naming the packages to the approval conversation', async () => {
    const sendMessage = vi.fn(async () => {});
    const notice = buildBakeOutcomeNotice(sendMessage);

    await notice.sendSuccessNotice({ dependency: bakeDependency() });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:approvals',
      'Dependency left-pad@1.3.0, pad-right@2.0.0 is baked and rolling out ' +
        'to workers — ready to use in about a minute. Re-ask the agent when ' +
        "you're ready.",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('sends the failure notice with the reason (unchanged)', async () => {
    const sendMessage = vi.fn(async () => {});
    const notice = buildBakeOutcomeNotice(sendMessage);

    await notice.sendFailureNotice({
      dependency: bakeDependency(),
      reason: 'npm install failed (exit 1)',
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:approvals',
      'Dependency bake failed: npm install failed (exit 1)',
    );
  });

  it('logs instead of sending when there is no approval conversation', async () => {
    const sendMessage = vi.fn(async () => {});
    const notice = buildBakeOutcomeNotice(sendMessage);

    await notice.sendSuccessNotice({
      dependency: bakeDependency({ approvedByConversationId: null }),
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ manifestHash: 'sha256:abc' }),
      'Toolchain bake succeeded but has no approval conversation to notify',
    );
  });

  it('logs delivery failures without throwing (never fails the bake)', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('channel down');
    });
    const notice = buildBakeOutcomeNotice(sendMessage);

    await expect(
      notice.sendSuccessNotice({ dependency: bakeDependency() }),
    ).resolves.toBeUndefined();
    await expect(
      notice.sendFailureNotice({
        dependency: bakeDependency(),
        reason: 'boom',
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'tg:approvals' }),
      'Failed to deliver toolchain bake success notice',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'tg:approvals' }),
      'Failed to deliver toolchain bake failure notice',
    );
  });
});

describe('startFleetSubsystems', () => {
  beforeEach(() => {
    latest.current = null;
    bakeMock.start.mockClear();
    bakeMock.stop.mockClear();
    reconcilerInstances.length = 0;
    loadState.markSettingsLoaded.mockClear();
    loadState.markSettingsNotLoaded.mockClear();
    importMock.importWorkstationSettings.mockClear();
    log.warn.mockClear();
    log.info.mockClear();
  });

  it('holds bake queue and reconciler until the first revision, then starts them and releases onSettingsReady', async () => {
    const onSettingsReady = vi.fn();
    const subsystems = await startFleetSubsystems({
      app: fakeApp,
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      pool: {} as never,
      sendMessage: async () => {},
      settingsLoaded: false,
      onSettingsReady,
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));

      // No revision yet: the listener runs, everything else is held.
      expect(subsystems.settingsRevisionListener).toBeDefined();
      expect(bakeMock.start).not.toHaveBeenCalled();
      expect(reconcilerInstances).toHaveLength(0);
      expect(onSettingsReady).not.toHaveBeenCalled();
      expect(loadState.markSettingsNotLoaded).toHaveBeenCalled();

      // First revision arrives: held services start, scheduler is released.
      latest.current = revisionRow(1);
      await subsystems.settingsRevisionListener.applyLatest();

      expect(bakeMock.start).toHaveBeenCalledOnce();
      expect(reconcilerInstances).toHaveLength(1);
      expect(reconcilerInstances[0]?.start).toHaveBeenCalledOnce();
      expect(onSettingsReady).toHaveBeenCalledOnce();

      // Subsequent revisions never double-start.
      latest.current = revisionRow(2);
      await subsystems.settingsRevisionListener.applyLatest();
      expect(bakeMock.start).toHaveBeenCalledOnce();
      expect(reconcilerInstances).toHaveLength(1);
      expect(onSettingsReady).toHaveBeenCalledOnce();
    } finally {
      await subsystems.stop();
    }
  });

  it('job-worker role starts the bake queue + reconciler', async () => {
    latest.current = revisionRow(1);
    const subsystems = await startFleetSubsystems({
      app: fakeApp,
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      pool: {} as never,
      sendMessage: async () => {},
      bakeExecution: true,
      capabilityReconciliation: true,
      settingsLoaded: true,
    });
    try {
      expect(bakeMock.start).toHaveBeenCalledOnce();
      expect(reconcilerInstances).toHaveLength(1);
    } finally {
      await subsystems.stop();
    }
  });

  it('live-worker role runs the reconciler but NOT the bake queue', async () => {
    latest.current = revisionRow(1);
    const subsystems = await startFleetSubsystems({
      app: fakeApp,
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      pool: {} as never,
      sendMessage: async () => {},
      bakeExecution: false,
      capabilityReconciliation: true,
      settingsLoaded: true,
    });
    try {
      expect(bakeMock.start).not.toHaveBeenCalled();
      expect(reconcilerInstances).toHaveLength(1);
    } finally {
      await subsystems.stop();
    }
  });

  it('control role runs neither bake nor reconciler, only the revision listener', async () => {
    latest.current = revisionRow(1);
    const subsystems = await startFleetSubsystems({
      app: fakeApp,
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      pool: {} as never,
      sendMessage: async () => {},
      bakeExecution: false,
      capabilityReconciliation: false,
      settingsLoaded: true,
    });
    try {
      expect(bakeMock.start).not.toHaveBeenCalled();
      expect(reconcilerInstances).toHaveLength(0);
      expect(subsystems.settingsRevisionListener).toBeDefined();
    } finally {
      await subsystems.stop();
    }
  });

  it('starts capability subsystems immediately when settings were loaded at boot', async () => {
    latest.current = revisionRow(1);
    const onSettingsReady = vi.fn();
    const subsystems = await startFleetSubsystems({
      app: fakeApp,
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      pool: {} as never,
      sendMessage: async () => {},
      settingsLoaded: true,
      onSettingsReady,
    });
    try {
      expect(bakeMock.start).toHaveBeenCalledOnce();
      expect(reconcilerInstances).toHaveLength(1);
      expect(reconcilerInstances[0]?.start).toHaveBeenCalledOnce();
      // Loaded boot is not "awaiting a revision": /readyz must not flap red.
      expect(loadState.markSettingsNotLoaded).not.toHaveBeenCalled();

      // The listener's re-apply of the boot revision must not double-start or
      // release a held scheduler that never existed.
      await new Promise((resolve) => setImmediate(resolve));
      await subsystems.settingsRevisionListener.applyLatest();
      expect(bakeMock.start).toHaveBeenCalledOnce();
      expect(onSettingsReady).not.toHaveBeenCalled();
    } finally {
      await subsystems.stop();
    }
  });
});
