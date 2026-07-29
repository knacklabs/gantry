import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeSettingsPublicSchema } from '@gantry/contracts';

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
  expect(config.getPublicRuntimeSettings().observer).toEqual({
    enabled: false,
  });
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
  defaults.agent.agentHarness = 'deepagents';
  defaults.agents.support = {
    name: 'Support',
    folder: 'support',
    agentHarness: 'anthropic_sdk',
    bindings: {},
    sources: { skills: [], mcpServers: [], tools: [] },
    capabilities: [],
    accessPreset: 'locked',
  };
  runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
  const config = await import('@core/config/index.js');

  const publicAgent = config.getPublicRuntimeSettings().agents.support;
  expect(config.getPublicRuntimeSettings().agent.agentHarness).toBe(
    'deepagents',
  );
  expect(publicAgent.agentHarness).toBe('anthropic_sdk');
  expect(publicAgent.access).toEqual({ preset: 'locked' });
  expect(publicAgent).not.toHaveProperty('accessPreset');
});

it('omits legacy providerConnection from public conversation settings', async () => {
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
    accessPreset: 'standard',
  };
  defaults.providerAccounts.slack_default = {
    agentId: 'support',
    provider: 'slack',
    label: 'Slack',
    runtimeSecretRefs: {},
  };
  defaults.conversations.slack_c123 = {
    providerConnection: 'slack_legacy',
    providerAccount: 'slack_default',
    externalId: 'C123',
    kind: 'channel',
    displayName: 'general',
    brainHarvest: true,
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: ['U1'],
    installedAgents: {},
  };
  runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
  const config = await import('@core/config/index.js');

  const publicSettings = config.getPublicRuntimeSettings();
  expect(publicSettings.conversations.slack_c123).toEqual({
    providerAccount: 'slack_default',
    externalId: 'C123',
    kind: 'channel',
    displayName: 'general',
    brainHarvest: true,
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: ['U1'],
    installedAgents: {},
  });
  expect(publicSettings.conversations.slack_c123).not.toHaveProperty(
    'providerConnection',
  );
  expect(() => RuntimeSettingsPublicSchema.parse(publicSettings)).not.toThrow();
});
