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
    path.join(os.tmpdir(), 'gantry-model-cli-'),
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
    expect(output).toContain('Available model aliases');
    expect(output).toContain('Alias | Model | Response family | Route');
    expect(output).toContain('opus-4.8 | Opus 4.8');
    expect(output).toContain('Opus 4.8');
    expect(output).toContain('kimi-2.6 | Kimi K2.6');
  });

  it('sets and resets chat and job defaults by alias', async () => {
    const runtimeHome = makeRuntimeHome();
    const preflightPreset = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'sonnet'], {
        preflightPreset,
      }),
    ).resolves.toBe(0);
    await expect(
      runModelCommand(runtimeHome, ['set', 'jobs', 'kimi 2.6'], {
        preflightPreset,
      }),
    ).resolves.toBe(0);

    let settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).toBe('sonnet');
    expect(settings.agent.oneTimeJobDefaultModel).toBe('kimi-2.6');
    expect(settings.agent.recurringJobDefaultModel).toBe('kimi-2.6');

    await expect(
      runModelCommand(runtimeHome, ['reset', 'jobs'], { preflightPreset }),
    ).resolves.toBe(0);
    settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.oneTimeJobDefaultModel).toBe('');
    expect(settings.agent.recurringJobDefaultModel).toBe('');
  });

  it('preflights OpenRouter aliases before direct CLI writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const preflightPreset = vi.fn(async () => ({
      ok: false,
      status: 'fail' as const,
      message: 'missing OpenRouter token',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'kimi'], {
        preflightPreset,
      }),
    ).resolves.toBe(1);
    let settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).not.toBe('kimi');

    settings.agent.defaultModel = 'kimi';
    settings.agent.oneTimeJobDefaultModel = 'sonnet';
    settings.agent.recurringJobDefaultModel = 'sonnet';
    saveRuntimeSettings(runtimeHome, settings);

    await expect(
      runModelCommand(runtimeHome, ['set', 'jobs', 'inherit'], {
        preflightPreset,
      }),
    ).resolves.toBe(1);
    settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.oneTimeJobDefaultModel).toBe('sonnet');
    expect(settings.agent.recurringJobDefaultModel).toBe('sonnet');
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Preset preflight failed: missing OpenRouter token',
    );
  });

  it('preflights Anthropic aliases before direct CLI writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const preflightPreset = vi.fn(async () => ({
      ok: false,
      status: 'fail' as const,
      message: 'missing Anthropic token',
    }));

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'sonnet'], {
        preflightPreset,
      }),
    ).resolves.toBe(1);

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).not.toBe('sonnet');
    expect(preflightPreset).toHaveBeenCalledWith(
      runtimeHome,
      'anthropic',
      expect.any(Object),
    );
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Preset preflight failed: missing Anthropic token',
    );
  });

  it('applies preset defaults only after credential preflight', async () => {
    const runtimeHome = makeRuntimeHome();
    const preflightPreset = vi.fn(async () => ({
      ok: true,
      status: 'pass' as const,
      message: 'ok',
    }));

    await expect(
      runModelCommand(runtimeHome, ['use-preset', 'openrouter'], {
        preflightPreset,
      }),
    ).resolves.toBe(0);
    expect(preflightPreset).toHaveBeenCalledWith(
      runtimeHome,
      'openrouter',
      expect.any(Object),
    );

    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.agent.defaultModel).toBe('kimi');
    expect(settings.agent.oneTimeJobDefaultModel).toBe('');
    expect(settings.agent.recurringJobDefaultModel).toBe('');
    expect(settings.memory.llm.models).toEqual({
      extractor: 'kimi',
      dreaming: 'kimi',
      consolidation: 'kimi',
    });
  });

  it('does not expose public memory tuning writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['set', 'memory', 'kimi']),
    ).resolves.toBe(1);

    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'gantry model set chat',
    );
  });

  it('rejects unsupported aliases and provider model IDs', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'unknown-model']),
    ).resolves.toBe(1);
    await expect(
      runModelCommand(runtimeHome, ['set', 'chat', 'moonshotai/kimi-k2.6']),
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

  it('fails doctor when Anthropic defaults are set without broker credentials', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.credentialBroker.mode = 'none';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(1);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Anthropic credentials: fail');
    expect(output).toContain('Status: fail');
  });

  it('fails doctor when any configured model alias is invalid', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'unknown-model';
    saveRuntimeSettings(runtimeHome, settings);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(1);

    const output = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('chat: invalid');
    expect(output).toContain('model aliases: fail');
    expect(output).toContain('Unknown model "unknown-model"');
    expect(output).toContain('Status: fail');
  });

  it('fails preset switch when OpenRouter credential preflight fails', async () => {
    const runtimeHome = makeRuntimeHome();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['use-preset', 'openrouter'], {
        preflightPreset: async () => ({
          ok: false,
          status: 'fail',
          message: 'missing OpenRouter token',
        }),
      }),
    ).resolves.toBe(1);

    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Preset preflight failed: missing OpenRouter token',
    );
  });
});
