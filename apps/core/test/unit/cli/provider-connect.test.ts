import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as prompts from '@clack/prompts';

import { runProviderConnectCommand } from '@core/cli/provider-connect.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-provider-connect-test-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

describe('runProviderConnectCommand', () => {
  it('rejects internal app channel connect commands', async () => {
    const errorSpy = vi
      .spyOn(prompts.log, 'error')
      .mockImplementation(() => {});

    const code = await runProviderConnectCommand(makeRuntimeHome(), 'app');

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown provider: app'),
    );
  });

  it('dispatches Teams connect through its built-in setup command', async () => {
    vi.resetModules();
    const runTeamsConnectCommand = vi.fn(async () => 0);
    vi.doMock('@core/cli/teams.js', () => ({
      runTeamsConnectCommand,
    }));
    const { runProviderConnectCommand: runConnect } =
      await import('@core/cli/provider-connect.js');
    const runtimeHome = makeRuntimeHome();

    const code = await runConnect(runtimeHome, 'teams');

    expect(code).toBe(0);
    expect(runTeamsConnectCommand).toHaveBeenCalledWith(runtimeHome);
  });

  it('dispatches Discord connect through its built-in setup command', async () => {
    vi.resetModules();
    const runDiscordConnectCommand = vi.fn(async () => 0);
    vi.doMock('@core/cli/discord.js', () => ({
      runDiscordConnectCommand,
    }));
    const { runProviderConnectCommand: runConnect } =
      await import('@core/cli/provider-connect.js');
    const runtimeHome = makeRuntimeHome();

    const code = await runConnect(runtimeHome, 'discord');

    expect(code).toBe(0);
    expect(runDiscordConnectCommand).toHaveBeenCalledWith(runtimeHome);
  });
});
