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
  expect(config.getPublicRuntimeSettings().runtime).not.toHaveProperty(
    'liveTurns',
  );
});

it('projects configured agent access using the public contract shape', async () => {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-settings-'),
  );
  runtimeHomes.push(runtimeHome);
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const runtimeSettings =
    await import('@core/config/settings/runtime-settings.js');
  const defaults = runtimeSettings.ensureRuntimeSettings(runtimeHome);
  defaults.agents.support = {
    name: 'Support',
    folder: 'support',
    bindings: {},
    sources: { skills: [], mcpServers: [], tools: [] },
    capabilities: [],
    accessPreset: 'locked',
  };
  runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
  const config = await import('@core/config/index.js');

  const publicAgent = config.getPublicRuntimeSettings().agents.support;
  expect(publicAgent.access).toEqual({ preset: 'locked' });
  expect(publicAgent).not.toHaveProperty('accessPreset');
});
