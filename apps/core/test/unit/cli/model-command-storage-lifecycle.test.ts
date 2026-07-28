import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modelCredentials = { kind: 'model-credentials' };
const release = vi.hoisted(() => vi.fn(async () => undefined));
const acquireRuntimeStorage = vi.hoisted(() =>
  vi.fn(async () => ({
    storage: { repositories: { modelCredentials } },
    owned: true,
    release,
  })),
);
const preflightModelProvider = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    status: 'pass' as const,
    message: 'ok',
  })),
);

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  acquireRuntimeStorage,
}));

vi.mock('@core/adapters/llm/model-provider-preflight.js', () => ({
  preflightModelProvider,
}));

import { runModelCommand } from '@core/cli/model.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-model-storage-lifecycle-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

beforeEach(() => {
  acquireRuntimeStorage.mockClear();
  preflightModelProvider.mockClear();
  release.mockClear();
});

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('model CLI storage lifecycle', () => {
  it.each([
    ['global chat', ['set', 'chat', 'gpt-terra']],
    ['jobs explicit', ['set', 'jobs', 'gpt-luna']],
    ['chat reset', ['reset', 'chat']],
    ['jobs reset', ['reset', 'jobs']],
    ['memory reset', ['reset', 'memory']],
    ['model doctor', ['doctor']],
  ])(
    'uses one owned storage runtime for default preflight: %s',
    async (_label, args) => {
      const runtimeHome = makeRuntimeHome();

      await expect(runModelCommand(runtimeHome, args)).resolves.toBe(0);

      expect(acquireRuntimeStorage).toHaveBeenCalledOnce();
      expect(preflightModelProvider).toHaveBeenCalled();
      expect(
        preflightModelProvider.mock.calls.every(
          ([input]) => input.modelCredentials === modelCredentials,
        ),
      ).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it('uses one owned storage runtime for an agent chat override', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agents.helper = {
      name: 'Helper',
      folder: 'helper',
      persona: 'developer',
      model: 'sonnet',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    saveRuntimeSettings(runtimeHome, settings);

    await expect(
      runModelCommand(runtimeHome, [
        'set',
        'chat',
        'gpt-sol',
        '--agent',
        'helper',
      ]),
    ).resolves.toBe(0);

    expect(acquireRuntimeStorage).toHaveBeenCalledOnce();
    expect(preflightModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ modelCredentials }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses one owned storage runtime when jobs inherit chat', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'gpt-sol';
    settings.agent.oneTimeJobDefaultModel = 'sonnet';
    settings.agent.recurringJobDefaultModel = 'sonnet';
    saveRuntimeSettings(runtimeHome, settings);

    await expect(
      runModelCommand(runtimeHome, ['set', 'jobs', 'inherit']),
    ).resolves.toBe(0);

    expect(acquireRuntimeStorage).toHaveBeenCalledOnce();
    expect(preflightModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ modelCredentials }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('shares one delayed acquisition across concurrent doctor preflights', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.agent.defaultModel = 'gpt-sol';
    saveRuntimeSettings(runtimeHome, settings);
    acquireRuntimeStorage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        storage: { repositories: { modelCredentials } },
        owned: true,
        release,
      };
    });

    await expect(runModelCommand(runtimeHome, ['doctor'])).resolves.toBe(0);

    expect(acquireRuntimeStorage).toHaveBeenCalledOnce();
    expect(preflightModelProvider).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ['status'],
    ['list'],
    ['chat'],
    ['jobs'],
    ['memory'],
    ['why', 'gpt-terra'],
    ['set', 'chat', 'unknown-model'],
    ['set', 'chat'],
    ['reset', 'unknown'],
  ])(
    'keeps read-only or invalid command DB-independent: %s',
    async (...args) => {
      const runtimeHome = makeRuntimeHome();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await runModelCommand(runtimeHome, args);

      expect(acquireRuntimeStorage).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    },
  );
});
