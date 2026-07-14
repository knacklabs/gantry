import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { updateRuntimeModelDefaults } from '@core/config/settings/model-defaults.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-model-defaults-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
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
