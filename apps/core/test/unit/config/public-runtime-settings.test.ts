import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

async function loadConfigForRuntimeHome(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_HOME', runtimeHome);
  return await import('@core/config/index.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('public runtime settings updates', () => {
  it('rejects patches that would enable dreaming while memory is disabled', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: false, dreaming: { enabled: true } },
      }),
    ).toThrow('memory.dreaming.enabled requires memory.enabled=true.');

    expect(config.getPublicRuntimeSettings().memory).toEqual({
      enabled: true,
      dreaming: { enabled: false },
    });
  });

  it('rejects disabling memory when dreaming is already enabled', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    config.updatePublicRuntimeSettings({
      memory: { dreaming: { enabled: true } },
    });

    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: false },
      }),
    ).toThrow('memory.dreaming.enabled requires memory.enabled=true.');

    expect(config.getPublicRuntimeSettings().memory).toEqual({
      enabled: true,
      dreaming: { enabled: true },
    });
  });
});
