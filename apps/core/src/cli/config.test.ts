import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runConfigCommand } from './config.js';
import { readEnvFile } from './env-file.js';
import { envFilePath } from './runtime-home.js';

function makeRuntimeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-config-test-'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config CLI commands', () => {
  it('sets and gets config keys', () => {
    const runtimeHome = makeRuntimeHome();

    expect(
      runConfigCommand(runtimeHome, [
        'set',
        'TELEGRAM_BOT_TOKEN',
        'abc123token',
      ]),
    ).toBe(0);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.TELEGRAM_BOT_TOKEN).toBe('abc123token');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      runConfigCommand(runtimeHome, ['get', 'TELEGRAM_BOT_TOKEN', '--raw']),
    ).toBe(0);
    expect(spy).toHaveBeenCalledWith('abc123token');
  });

  it('lists env keys without runtime-compatibility annotations', () => {
    const runtimeHome = makeRuntimeHome();

    runConfigCommand(runtimeHome, ['set', 'TELEGRAM_BOT_TOKEN', 'abc123token']);
    runConfigCommand(runtimeHome, ['set', 'MEMORY_PROVIDER', 'sqlite']);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(runConfigCommand(runtimeHome, ['list'])).toBe(0);
    const output = spy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain('MEMORY_PROVIDER=sqlite');
    expect(output).not.toContain('ignored for runtime behavior');
    expect(output).toContain('TELEGRAM_BOT_TOKEN=abc***ken');
  });

  it('unsets keys', () => {
    const runtimeHome = makeRuntimeHome();

    runConfigCommand(runtimeHome, ['set', 'OPENAI_API_KEY', 'secret-value']);
    expect(runConfigCommand(runtimeHome, ['unset', 'OPENAI_API_KEY'])).toBe(0);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
