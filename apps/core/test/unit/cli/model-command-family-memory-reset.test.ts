import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/cli/control-api.js', () => ({
  controlApiRequest: vi.fn(async () => ({
    providers: [{ providerId: 'cerebras', configured: true }],
  })),
}));

import { runModelCommand } from '@core/cli/model.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-model-family-reset-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('model CLI family memory reset', () => {
  it('uses configured family provider when resetting memory defaults', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'gpt-oss';
    saveRuntimeSettings(runtimeHome, settings);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const preflightProvider = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['reset', 'memory'], {
        preflightProvider,
      }),
    ).resolves.toBe(0);

    expect(preflightProvider).toHaveBeenCalledWith(
      runtimeHome,
      'cerebras',
      expect.any(Object),
      undefined,
    );
    expect(loadRuntimeSettings(runtimeHome).memory.llm.models).toEqual({
      extractor: 'cerebras',
      dreaming: 'cerebras',
      consolidation: 'cerebras',
    });
  });
});
