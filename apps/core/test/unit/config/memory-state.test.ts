import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { settingsFilePath } from '@core/config/settings/runtime-home.js';

const runtimeHomes: string[] = [];

async function loadMemoryState(snapshot: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('@core/config/settings/runtime-settings.js', () => ({
    readRuntimeMemorySettingsSnapshot: vi.fn(() => snapshot),
  }));
  return import('@core/config/memory-state.js');
}

async function loadMemoryStateFromSettings(yaml?: string) {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-memory-state-'),
  );
  runtimeHomes.push(runtimeHome);
  if (yaml !== undefined) {
    fs.writeFileSync(settingsFilePath(runtimeHome), yaml);
  }
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  return import('@core/config/memory-state.js');
}

describe('runtime memory state', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@core/config/settings/runtime-settings.js');
    vi.resetModules();
    for (const runtimeHome of runtimeHomes.splice(0)) {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('defaults memory dreaming off when settings are absent', async () => {
    const state = await loadMemoryState({});

    expect(state.RUNTIME_MEMORY_ENABLED).toBe(true);
    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(false);
    expect(state.RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED).toBe(false);
  });

  it('keeps memory dreaming off when memory settings omit dreaming.enabled', async () => {
    const state = await loadMemoryState({ enabled: true });

    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(false);
    expect(state.RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED).toBe(false);
  });

  it('enables memory dreaming only from explicit runtime settings', async () => {
    const state = await loadMemoryState({ dreamingEnabled: true });

    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(true);
  });

  it('defaults memory dreaming alerts off when settings.yaml is absent', async () => {
    const state = await loadMemoryStateFromSettings();

    expect(state.RUNTIME_MEMORY_ENABLED).toBe(true);
    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(false);
    expect(state.RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED).toBe(false);
  });

  it('keeps memory dreaming alerts off when settings.yaml omits dreaming.alerts', async () => {
    const state = await loadMemoryStateFromSettings(`memory:
  dreaming:
    enabled: true
`);

    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(true);
    expect(state.RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED).toBe(false);
  });

  it('enables memory dreaming alerts only from explicit settings.yaml', async () => {
    const state = await loadMemoryStateFromSettings(`memory:
  dreaming:
    enabled: true
    alerts: true
`);

    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(true);
    expect(state.RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED).toBe(true);
  });
});
