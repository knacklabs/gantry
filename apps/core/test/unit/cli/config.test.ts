import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runConfigCommand } from '@core/cli/config.js';
import { readEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';

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

  it('lists env keys without runtime-specific annotations', () => {
    const runtimeHome = makeRuntimeHome();

    runConfigCommand(runtimeHome, ['set', 'TELEGRAM_BOT_TOKEN', 'abc123token']);
    runConfigCommand(runtimeHome, ['set', 'MEMORY_MODE', 'postgres']);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(runConfigCommand(runtimeHome, ['list'])).toBe(0);
    const output = spy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain('MEMORY_MODE=postgres');
    expect(output).not.toContain('ignored for runtime behavior');
    expect(output).toContain('TELEGRAM_BOT_TOKEN=abc***ken');
  });

  it('masks credential-bearing database URLs by default', () => {
    const runtimeHome = makeRuntimeHome();

    runConfigCommand(runtimeHome, [
      'set',
      'ONECLI_DATABASE_URL',
      'postgresql://onecli:secret@localhost:5432/myclaw?schema=onecli',
    ]);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(runConfigCommand(runtimeHome, ['get', 'ONECLI_DATABASE_URL'])).toBe(
      0,
    );
    const output = spy.mock.calls.at(-1)?.[0] as string;

    expect(output).toContain('pos***cli');
    expect(output).not.toContain('secret');
  });

  it('blocks direct provider credential writes', () => {
    const runtimeHome = makeRuntimeHome();

    expect(
      runConfigCommand(runtimeHome, ['set', 'OPENAI_API_KEY', 'secret-value']),
    ).toBe(1);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('blocks direct Anthropic credential writes', () => {
    const runtimeHome = makeRuntimeHome();

    expect(
      runConfigCommand(runtimeHome, [
        'set',
        'ANTHROPIC_API_KEY',
        'secret-value',
      ]),
    ).toBe(1);
    expect(
      runConfigCommand(runtimeHome, [
        'set',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'secret-value',
      ]),
    ).toBe(1);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('unsets keys', () => {
    const runtimeHome = makeRuntimeHome();

    runConfigCommand(runtimeHome, [
      'set',
      'TELEGRAM_BOT_TOKEN',
      'secret-value',
    ]);
    expect(runConfigCommand(runtimeHome, ['unset', 'TELEGRAM_BOT_TOKEN'])).toBe(
      0,
    );

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});
