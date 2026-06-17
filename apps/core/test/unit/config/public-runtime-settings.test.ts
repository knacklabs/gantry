import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

it('redacts owner-defined browser usage override sites from public settings', async () => {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-settings-'),
  );
  runtimeHomes.push(runtimeHome);
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const runtimeSettings =
    await import('@core/config/settings/runtime-settings.js');
  const defaults = runtimeSettings.ensureRuntimeSettings(runtimeHome);
  defaults.browser.usage = {
    enabled: true,
    mode: 'audit',
    windowMs: 60_000,
    maxActionsPerWindow: 100,
    maxConcurrentPerSite: 2,
    overrides: {
      'example.test': { mode: 'enforce' },
    },
  };
  runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
  const config = await import('@core/config/index.js');

  expect(config.getPublicRuntimeSettings().browser.usage).toEqual({
    enabled: true,
    mode: 'audit',
    windowMs: 60_000,
    maxActionsPerWindow: 100,
    maxConcurrentPerSite: 2,
  });
});

it('keeps warm pool enablement settings-owned even when legacy env is set', async () => {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-settings-'),
  );
  runtimeHomes.push(runtimeHome);
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  await import('@core/config/settings/runtime-settings.js');
  const config = await import('@core/config/index.js');

  expect(config.getRuntimeWarmPoolConfig({})).toEqual({
    enabled: false,
    size: 1,
    idleTtlMs: 240_000,
    maxBoundWorkers: 100,
    cachePrewarmEnabled: false,
    cachePrewarmConcurrency: 1,
  });
  expect(config.getRuntimeWarmPoolConfig({ GANTRY_WARM_POOL: '1' })).toEqual({
    enabled: false,
    size: 1,
    idleTtlMs: 240_000,
    maxBoundWorkers: 100,
    cachePrewarmEnabled: false,
    cachePrewarmConcurrency: 1,
  });
});

it('keeps runner idle timeout settings-owned even when legacy env is set', async () => {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-settings-'),
  );
  runtimeHomes.push(runtimeHome);
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  await import('@core/config/settings/runtime-settings.js');
  const config = await import('@core/config/index.js');

  expect(config.getRuntimeRunnerConfig({})).toEqual({
    idleTimeoutMs: 1_800_000,
  });
  expect(config.getRuntimeRunnerConfig({ IDLE_TIMEOUT: '2500' })).toEqual({
    idleTimeoutMs: 1_800_000,
  });
});

it('exposes settings-owned runtime ownership timing', async () => {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-settings-'),
  );
  runtimeHomes.push(runtimeHome);
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const runtimeSettings =
    await import('@core/config/settings/runtime-settings.js');
  const defaults = runtimeSettings.ensureRuntimeSettings(runtimeHome);
  defaults.runtime.ownership = {
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    reconcilerIntervalMs: 2_500,
    reconcilerLimit: 50,
    shutdownClaimWaitMs: 250,
  };
  runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
  const config = await import('@core/config/index.js');

  expect(config.getPublicRuntimeSettings().runtime.ownership).toEqual({
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    reconcilerIntervalMs: 2_500,
    reconcilerLimit: 50,
    shutdownClaimWaitMs: 250,
  });
  expect(config.getRuntimeOwnershipConfig()).toEqual({
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    reconcilerIntervalMs: 2_500,
    reconcilerLimit: 50,
    shutdownClaimWaitMs: 250,
  });
});

it('exposes settings-owned trace payload retention timing', async () => {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-settings-'),
  );
  runtimeHomes.push(runtimeHome);
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const runtimeSettings =
    await import('@core/config/settings/runtime-settings.js');
  const defaults = runtimeSettings.ensureRuntimeSettings(runtimeHome);
  defaults.runtime.trace = {
    payloadRetentionMs: 7_200_000,
    payloadCleanupIntervalMs: 60_000,
  };
  runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
  const config = await import('@core/config/index.js');

  expect(config.getPublicRuntimeSettings().runtime.trace).toEqual({
    payloadRetentionMs: 7_200_000,
    payloadCleanupIntervalMs: 60_000,
  });
  expect(config.getRuntimeTraceConfig()).toEqual({
    payloadRetentionMs: 7_200_000,
    payloadCleanupIntervalMs: 60_000,
  });
});
