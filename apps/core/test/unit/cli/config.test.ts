import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runConfigCommand } from '@core/cli/config.js';
import { readEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

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

  it('migrates wrong-lane .env settings into settings.yaml', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      envFilePath(runtimeHome),
      [
        'MYCLAW_CREDENTIAL_MODE=external',
        'ONECLI_URL=http://localhost:10254',
        'ANTHROPIC_BASE_URL=https://broker.local/anthropic',
        'ANTHROPIC_MODEL=sonnet',
        'SLACK_PERMISSION_APPROVER_IDS=U123,U456',
        'ANTHROPIC_API_KEY=sk-ant-old',
        '',
      ].join('\n'),
    );

    expect(runConfigCommand(runtimeHome, ['migrate-env'])).toBe(0);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.MYCLAW_CREDENTIAL_MODE).toBeUndefined();
    expect(env.ONECLI_URL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.SLACK_PERMISSION_APPROVER_IDS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.credentialBroker.mode).toBe('external');
    expect(settings.credentialBroker.onecli.url).toBe('http://localhost:10254');
    expect(settings.credentialBroker.external.baseUrl).toBe(
      'https://broker.local/anthropic',
    );
    expect(settings.agent.defaultModel).toBe('sonnet');
    expect(settings.channels.slack.controlAllowlist.default).toEqual([
      'U123',
      'U456',
    ]);
  });

  it('merges migrated Slack approvers with existing settings allowlists', () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.channels.slack.controlAllowlist.default = ['U_EXISTING'];
    settings.channels.slack.controlAllowlist.agents.agent_a = ['U_AGENT'];
    saveRuntimeSettings(runtimeHome, settings);
    fs.writeFileSync(
      envFilePath(runtimeHome),
      ['SLACK_PERMISSION_APPROVER_IDS=U123,U_EXISTING', ''].join('\n'),
    );

    expect(runConfigCommand(runtimeHome, ['migrate-env'])).toBe(0);

    const migrated = loadRuntimeSettings(runtimeHome);
    expect(migrated.channels.slack.controlAllowlist.default).toEqual([
      'U_EXISTING',
      'U123',
    ]);
    expect(migrated.channels.slack.controlAllowlist.agents.agent_a).toEqual([
      'U_AGENT',
    ]);
  });

  it('fails migration on invalid legacy credential mode without removing it', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      envFilePath(runtimeHome),
      ['MYCLAW_CREDENTIAL_MODE=externl', ''].join('\n'),
    );

    expect(runConfigCommand(runtimeHome, ['migrate-env'])).toBe(1);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.MYCLAW_CREDENTIAL_MODE).toBe('externl');
    expect(loadRuntimeSettings(runtimeHome).credentialBroker.mode).toBe(
      'onecli',
    );
  });

  it('fails migration when classified settings need manual handling', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      envFilePath(runtimeHome),
      ['ANTHROPIC_DEFAULT_OPUS_MODEL=custom-opus', ''].join('\n'),
    );

    expect(runConfigCommand(runtimeHome, ['migrate-env'])).toBe(1);

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('custom-opus');
  });
});
