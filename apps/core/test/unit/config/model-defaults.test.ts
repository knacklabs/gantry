import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateRuntimeModelDefaults } from '@core/config/settings/model-defaults.js';
import { configureDesiredSettingsStorageProvider } from '@core/config/settings/desired-settings-writer.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const importWorkstationSettings = vi.hoisted(() => vi.fn());

vi.mock(
  '@core/config/settings/settings-import-service.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    importWorkstationSettings,
  }),
);

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-model-defaults-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  configureDesiredSettingsStorageProvider(undefined);
  importWorkstationSettings.mockReset();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('updateRuntimeModelDefaults', () => {
  it('resets provider-managed memory from the configured family member', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'gpt-oss';
    saveRuntimeSettings(runtimeHome, settings);
    importWorkstationSettings.mockImplementation(async (deps, nextSettings) => {
      saveRuntimeSettings(deps.runtimeHome, nextSettings);
      return { status: 'revision_created', revision: 1 };
    });
    configureDesiredSettingsStorageProvider(async () => ({
      ops: {} as never,
      repositories: {} as never,
      settingsRevisions: {} as never,
    }));

    await expect(
      updateRuntimeModelDefaults({
        runtimeHome,
        body: { memory: 'reset' },
        getConfiguredModelProviderIds: async () => new Set(['cerebras']),
      }),
    ).resolves.toEqual({ ok: true });

    expect(loadRuntimeSettings(runtimeHome).memory.llm.models).toEqual({
      extractor: 'cerebras',
      dreaming: 'cerebras',
      consolidation: 'cerebras',
    });
  });
});
