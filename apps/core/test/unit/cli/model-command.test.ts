import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runModelCommand } from '@core/cli/model.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-model-cli-'),
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

describe('model CLI command', () => {
  it('lists the supported model catalog', async () => {
    const runtimeHome = makeRuntimeHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['list'])).resolves.toBe(0);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Supported models');
    expect(output).toContain('Opus 4.7');
    expect(output).toContain('Kimi K2.6');
  });

  it('sets model defaults by alias for different lanes', async () => {
    const runtimeHome = makeRuntimeHome();

    await expect(
      runModelCommand(runtimeHome, ['set-default', 'chat', 'sonnet']),
    ).resolves.toBe(0);
    await expect(
      runModelCommand(runtimeHome, ['set-default', 'once', 'kimi 2.6']),
    ).resolves.toBe(0);
    await expect(
      runModelCommand(runtimeHome, ['set-default', 'recurring', 'opus-4.6']),
    ).resolves.toBe(0);

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).toBe('sonnet');
    expect(settings.agent.oneTimeJobDefaultModel).toBe('kimi');
    expect(settings.agent.recurringJobDefaultModel).toBe('opus-4.6');
  });

  it('rejects unsupported aliases and provider model IDs', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['set-default', 'chat', 'unknown-model']),
    ).resolves.toBe(1);
    await expect(
      runModelCommand(runtimeHome, [
        'set-default',
        'chat',
        'moonshotai/kimi-k2.6',
      ]),
    ).resolves.toBe(1);

    const output = errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Unknown model "unknown-model"');
    expect(output).toContain('Provider model ID "moonshotai/kimi-k2.6"');
  });

  it('fails doctor when OpenRouter defaults are set without broker credentials', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'kimi';
    settings.credentialBroker.mode = 'none';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(1);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('OpenRouter credentials: fail');
    expect(output).toContain('Status: fail');
  });

  it('warns (not fails) doctor when OpenRouter defaults use a broker mode', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.oneTimeJobDefaultModel = 'kimi';
    settings.credentialBroker.mode = 'external';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(0);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('OpenRouter credentials: warn');
    expect(output).toContain('Status: warn');
  });
});
