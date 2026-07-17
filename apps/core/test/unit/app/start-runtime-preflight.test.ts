import { describe, expect, it, vi } from 'vitest';

const startRuntimeServicesError = new Error('stop after preflight gate');
const validateRuntimePreflightWithStorage = vi.fn(async () => ({ ok: true }));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  installGlobalErrorHandlers: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: vi.fn(),
}));
vi.mock('@core/app/bootstrap/runtime-app.js', () => ({
  getDefaultRuntimeApp: vi.fn(() => ({
    queue: { getPolicy: () => ({ maxMessageRuns: 1 }) },
    setChannelRuntime: vi.fn(),
  })),
}));
vi.mock('@core/app/bootstrap/channel-wiring.js', () => ({
  createChannelWiring: vi.fn(() => ({
    hasChannel: false,
    supportsStreaming: false,
    supportsProgress: false,
    sendMessage: vi.fn(),
    sendStreamingChunk: vi.fn(),
    resetStreaming: vi.fn(),
    setTyping: vi.fn(),
    sendProgressUpdate: vi.fn(),
    renderAgentTodo: vi.fn(),
    isControlApproverAllowed: vi.fn(),
    disconnectChannels: vi.fn(),
    setRuntimeSecrets: vi.fn(),
    connectEnabledChannels: vi.fn(async () => undefined),
    hasConnectedChannels: vi.fn(() => false),
  })),
}));
vi.mock('@core/app/bootstrap/startup.js', () => ({
  runStartup: vi.fn(async () => ({
    runtimeSettings: { runtime: { liveTurns: { enabled: true } } },
    initTracingFromSettings: vi.fn(),
    closeTracing: vi.fn(async () => {}),
  })),
}));
vi.mock('@core/app/bootstrap/runtime-services.js', () => ({
  startRuntimeServices: vi.fn(async () => {
    throw startRuntimeServicesError;
  }),
  beginDrainingLiveTurnAdmission: vi.fn(),
  shutdownLiveTurnAuthority: vi.fn(),
  stopAsyncTaskRecoveryLoop: vi.fn(),
  stopLiveTurnRecoveryLoop: vi.fn(),
  stopLiveAdmissionLoop: vi.fn(),
  getOldestWaitingLiveAdmissionSeconds: vi.fn(() => 0),
}));
vi.mock('@core/app/bootstrap/shutdown.js', () => ({
  installShutdownHandlers: vi.fn(),
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  closeRuntimeStorage: vi.fn(),
  getRuntimeControlRepository: vi.fn(),
  getRuntimeEventExchange: vi.fn(() => ({ publish: vi.fn() })),
  getRuntimeSkillArtifactStore: vi.fn(),
  getRuntimeStorage: vi.fn(() => ({
    ops: {},
    repositories: { capabilitySecrets: {} },
    service: { pool: {} },
  })),
  tryAcquireRuntimeAdvisoryLease: vi.fn(),
}));
vi.mock('@core/control/server/index.js', () => ({
  startControlServer: vi.fn(),
}));
vi.mock('@core/jobs/scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
  stopSchedulerLoop: vi.fn(),
  isSchedulerReady: vi.fn(() => true),
}));
vi.mock('@core/jobs/outbound-delivery-recovery.js', () => ({
  stopOutboundDeliveryRecoveryLoop: vi.fn(),
}));
vi.mock('@core/jobs/browser-activity-events.js', () => ({
  publishBrowserJobActivityEvent: vi.fn(),
}));
vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-test',
  getDeploymentMode: vi.fn(() => 'workstation'),
  getRuntimeQueueConfig: vi.fn(() => ({ drainDeadlineMs: 1 })),
  loadRuntimeSettings: vi.fn(),
}));
vi.mock('@core/runtime/browser-capability.js', () => ({
  getBrowserStatus: vi.fn(),
}));
vi.mock('@core/runtime/settings-reload-watcher.js', () => ({
  startSettingsReloadWatcher: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('@core/app/bootstrap/fleet-boot.js', () => ({
  prepareFleetSettings: vi.fn(),
  startFleetSubsystems: vi.fn(),
}));
vi.mock('@core/config/preflight.js', () => ({
  formatRuntimePreflightFailure: vi.fn(() => 'preflight failed'),
  validateRuntimePreflight: vi.fn(() => ({ ok: true })),
  validateRuntimePreflightWithStorage,
}));
vi.mock('@core/app/bootstrap/live-recovery-coordinator.js', () => ({
  startLiveRecoveryCoordinatorLeaseAcquisition: vi.fn(() => ({
    stop: vi.fn(async () => undefined),
  })),
}));
vi.mock('@core/app/bootstrap/roles/role-resolver.js', () => ({
  resolveProcessRole: vi.fn(() => 'all'),
}));
vi.mock('@core/app/bootstrap/roles/role-capabilities.js', () => ({
  roleCapabilities: vi.fn(() => ({
    providerInbound: true,
    liveExecution: true,
    jobExecution: true,
    controlApi: true,
    bakeExecution: true,
    workerRegistration: true,
  })),
}));
vi.mock('@core/app/bootstrap/roles/role-readiness.js', () => ({
  roleReadinessRequirements: vi.fn(),
}));
vi.mock('@core/jobs/worker-identity.js', () => ({
  currentWorkerInstanceId: 'worker-test',
}));
vi.mock('@core/infrastructure/network/hostname-lookup.js', () => ({
  defaultHostnameLookup: vi.fn(),
}));
vi.mock(
  '@core/adapters/credentials/repository-runtime-secret-provider.js',
  () => ({
    createRepositoryRuntimeSecretProvider: vi.fn(() => ({})),
  }),
);

describe('startGantryRuntime preflight', () => {
  it('honors skipPreflight at runtime entry', async () => {
    const { startGantryRuntime } = await import('@core/app/index.js');

    await expect(startGantryRuntime({ skipPreflight: true })).rejects.toThrow(
      startRuntimeServicesError,
    );

    expect(validateRuntimePreflightWithStorage).not.toHaveBeenCalled();
  });
});
