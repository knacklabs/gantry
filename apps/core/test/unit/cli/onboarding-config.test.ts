import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { persistOnboardingConfig } from '@core/cli/onboarding-config.js';
import { readEnvFile } from '@core/config/env/file.js';
import {
  envFilePath,
  settingsFilePath,
} from '@core/config/settings/runtime-home.js';
import { loadRuntimeSettingsFromPath } from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-onboarding-config-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

function baseInput(runtimeHome: string) {
  return {
    runtimeHome,
    postgresDatabaseUrl: 'postgresql://gantry_app:pass@localhost:15432/gantry',
    onecliPostgresDatabaseUrl:
      'postgresql://onecli_app:pass@localhost:15432/gantry?schema=onecli',
    postgresSchema: 'gantry',
    onecliPostgresSchema: 'onecli',
    primaryProvider: 'telegram' as const,
    telegramBotToken: 'telegram-token',
    telegramPermissionApproverIds: '123',
    credentialMode: 'onecli' as const,
    onecliUrl: 'http://localhost:10254',
    agentName: 'Kai',
    modelPreset: 'anthropic' as const,
    modelAlias: 'sonnet',
    memoryEnabled: true,
    embeddingsEnabled: false,
    dreamingEnabled: true,
  };
}

afterEach(() => {
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('onboarding config persistence', () => {
  it('clears raw provider credentials while writing brokered runtime config', () => {
    const runtimeHome = makeRuntimeHome();
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      envFilePath(runtimeHome),
      [
        'OPENAI_API_KEY=sk-old',
        'ANTHROPIC_API_KEY=sk-ant-old',
        'ANTHROPIC_AUTH_TOKEN=ant-token',
        'CLAUDE_CODE_OAUTH_TOKEN=oauth-old',
        'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
        '',
      ].join('\n'),
    );

    persistOnboardingConfig(baseInput(runtimeHome));

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.GANTRY_DATABASE_URL).toContain('gantry_app');
    expect(env.ONECLI_DATABASE_URL).toContain('onecli_app');
    expect(env.SECRET_ENCRYPTION_KEY).toBe(
      '123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    );
    expect(env.ONECLI_URL).toBeUndefined();
    expect(env.GANTRY_CREDENTIAL_MODE).toBeUndefined();
    expect(env.SLACK_PERMISSION_APPROVER_IDS).toBeUndefined();
    expect(env.TELEGRAM_PERMISSION_APPROVER_IDS).toBeUndefined();
    const settings = loadRuntimeSettingsFromPath(settingsFilePath(runtimeHome));
    expect(settings.credentialBroker.mode).toBe('onecli');
    expect(settings.credentialBroker.onecli.url).toBe('http://localhost:10254');
    expect(settings.agent.name).toBe('Kai');
    expect(settings.agent.defaultModel).toBe('sonnet');
    expect(settings.memory.llm.models).toEqual({
      extractor: 'haiku',
      dreaming: 'sonnet',
      consolidation: 'sonnet',
    });
  });

  it('generates a stable OneCLI encryption key when none exists', () => {
    const runtimeHome = makeRuntimeHome();

    persistOnboardingConfig(baseInput(runtimeHome));

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.SECRET_ENCRYPTION_KEY).toHaveLength(44);
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
  });

  it('applies the OpenRouter preset defaults for chat and memory models', () => {
    const runtimeHome = makeRuntimeHome();

    persistOnboardingConfig({
      ...baseInput(runtimeHome),
      modelPreset: 'openrouter',
      modelAlias: 'kimi',
    });

    const settings = loadRuntimeSettingsFromPath(settingsFilePath(runtimeHome));
    expect(settings.agent.defaultModel).toBe('kimi');
    expect(settings.agent.oneTimeJobDefaultModel).toBe('');
    expect(settings.agent.recurringJobDefaultModel).toBe('');
    expect(settings.memory.llm.models).toEqual({
      extractor: 'kimi',
      dreaming: 'kimi',
      consolidation: 'kimi',
    });
  });

  it('rejects raw provider model IDs at the setup config boundary', () => {
    const runtimeHome = makeRuntimeHome();

    expect(() =>
      persistOnboardingConfig({
        ...baseInput(runtimeHome),
        modelAlias: 'claude-sonnet-4-6',
      }),
    ).toThrow(/Provider model ID/);
  });

  it('keeps Slack approvers out of .env until a conversation is selected', () => {
    const runtimeHome = makeRuntimeHome();

    persistOnboardingConfig({
      ...baseInput(runtimeHome),
      primaryProvider: 'slack',
      telegramBotToken: undefined,
      slackBotToken: 'xoxb-token',
      slackAppToken: 'xapp-token',
      slackPermissionApproverIds: 'U123,U456 U123',
    });

    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.SLACK_PERMISSION_APPROVER_IDS).toBeUndefined();
    const settings = loadRuntimeSettingsFromPath(settingsFilePath(runtimeHome));
    expect(settings.providers.slack.enabled).toBe(true);
    expect(settings.conversations).toEqual({});
  });

  it('requires OneCLI database URL when Gantry database URL is configured', () => {
    const runtimeHome = makeRuntimeHome();

    expect(() =>
      persistOnboardingConfig({
        ...baseInput(runtimeHome),
        onecliPostgresDatabaseUrl: '',
      }),
    ).toThrow(/ONECLI_DATABASE_URL is required/);

    expect(
      readEnvFile(envFilePath(runtimeHome)).GANTRY_DATABASE_URL,
    ).toBeUndefined();
  });

  it('rejects OneCLI database URLs that do not share the Gantry database', () => {
    const runtimeHome = makeRuntimeHome();

    expect(() =>
      persistOnboardingConfig({
        ...baseInput(runtimeHome),
        onecliPostgresDatabaseUrl:
          'postgresql://onecli_app:pass@localhost:15432/other?schema=onecli',
      }),
    ).toThrow(/same Postgres database/);

    expect(
      readEnvFile(envFilePath(runtimeHome)).GANTRY_DATABASE_URL,
    ).toBeUndefined();
  });
});
