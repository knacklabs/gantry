import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const controlApiRequest = vi.hoisted(() => vi.fn());

vi.mock('@core/cli/control-api.js', () => ({ controlApiRequest }));

import { runModelCommand } from '@core/cli/model.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
  controlApiRequest.mockReset();
  vi.restoreAllMocks();
});

describe('model discovery CLI', () => {
  it('shows retained aliases and actionable discovery state', async () => {
    const runtimeHome = makeRuntimeHome();
    controlApiRequest.mockResolvedValue({
      providerId: 'anthropic',
      providerLabel: 'Anthropic',
      discoverySource: 'cache',
      refreshedAt: '2026-08-03T00:00:00.000Z',
      refreshError:
        'Anthropic model discovery failed: provider offline. Saved aliases were retained.',
      models: [
        {
          providerModelId: 'claude-opus-5',
          displayName: 'Opus 5',
          aliases: ['opus'],
          availability: 'availability_unknown',
        },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, ['discover', 'anthropic']),
    ).resolves.toBe(0);

    expect(controlApiRequest).toHaveBeenCalledWith(runtimeHome, {
      method: 'GET',
      path: '/v1/model-providers/anthropic/models',
    });
    expect(log.mock.calls.at(-1)?.[0]).toContain('Saved aliases were retained');
    expect(log.mock.calls.at(-1)?.[0]).toContain('aliases: opus');
  });

  it('registers through the current desired-state revision', async () => {
    const runtimeHome = makeRuntimeHome();
    controlApiRequest
      .mockResolvedValueOnce({ revision: 12 })
      .mockResolvedValueOnce({ revision: 13, alias: 'new-model' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runModelCommand(runtimeHome, [
        'register',
        'openrouter',
        'vendor/new-model',
        '--alias',
        'new-model',
      ]),
    ).resolves.toBe(0);

    expect(controlApiRequest).toHaveBeenNthCalledWith(2, runtimeHome, {
      method: 'POST',
      path: '/v1/model-registrations',
      body: {
        providerId: 'openrouter',
        providerModelId: 'vendor/new-model',
        alias: 'new-model',
        expectedRevision: 12,
      },
    });
    expect(log).toHaveBeenLastCalledWith(
      'Registered new-model at settings revision 13.',
    );
  });

  it('requests an explicit provider refresh', async () => {
    const runtimeHome = makeRuntimeHome();
    controlApiRequest.mockResolvedValue({
      providerLabel: 'Anthropic',
      discoverySource: 'live',
      refreshError: null,
      models: [],
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runModelCommand(runtimeHome, ['discover', 'anthropic', '--refresh']);

    expect(controlApiRequest).toHaveBeenCalledWith(runtimeHome, {
      method: 'GET',
      path: '/v1/model-providers/anthropic/models?refresh=true',
    });
  });

  it('escapes provider-controlled terminal sequences', async () => {
    const runtimeHome = makeRuntimeHome();
    controlApiRequest.mockResolvedValue({
      providerLabel: 'Anthropic',
      discoverySource: 'live',
      refreshError: null,
      models: [
        {
          providerModelId: 'safe-id',
          displayName: '\u001b]8;;https://example.com\u0007unsafe',
          aliases: [],
          availability: 'available_to_register',
        },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runModelCommand(runtimeHome, ['discover', 'anthropic']);

    expect(log.mock.calls.at(-1)?.[0]).not.toContain('\u001b');
    expect(log.mock.calls.at(-1)?.[0]).toContain('\\u001b');
  });
});

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-model-discovery-cli-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}
