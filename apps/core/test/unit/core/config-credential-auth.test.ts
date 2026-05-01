import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveClaudeAuthState', () => {
  let runtimeRoot = '';

  function writeCredentialSettings(
    mode: 'none' | 'onecli' | 'external',
    externalBaseUrl = '',
  ): void {
    fs.writeFileSync(
      path.join(runtimeRoot, 'settings.yaml'),
      [
        'channels: {}',
        'storage:',
        '  postgres:',
        '    url_env: MYCLAW_DATABASE_URL',
        '    schema: myclaw',
        'agent:',
        '  default_model: ""',
        'credential_broker:',
        `  mode: ${mode}`,
        '  onecli:',
        '    url: http://localhost:10254',
        '  external:',
        `    base_url: "${externalBaseUrl}"`,
        'memory:',
        '  enabled: true',
        '  embeddings:',
        '    enabled: false',
        '    provider: disabled',
        '    model: text-embedding-3-large',
        '  dreaming:',
        '    enabled: false',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  function createRuntimeHome(
    mode: 'none' | 'onecli' | 'external',
    externalBaseUrl = '',
  ): void {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-config-'));
    writeCredentialSettings(mode, externalBaseUrl);
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
  }

  afterEach(() => {
    if (runtimeRoot) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = '';
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('does not treat model-only external mode as broker auth', async () => {
    createRuntimeHome('external');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.resetModules();

    const { resolveClaudeAuthState } = await import('@core/config/index.js');

    expect(resolveClaudeAuthState().mode).toBe('none');
  });

  it('treats external mode as broker auth when a broker endpoint exists', async () => {
    createRuntimeHome('external', 'https://broker.local/anthropic');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    vi.resetModules();

    const { resolveClaudeAuthState } = await import('@core/config/index.js');

    expect(resolveClaudeAuthState().mode).toBe('broker');
  });

  it('reads credential broker settings live after module import', async () => {
    createRuntimeHome('none');
    vi.resetModules();

    const { getCredentialBrokerRuntimeConfig, resolveClaudeAuthState } =
      await import('@core/config/index.js');
    expect(getCredentialBrokerRuntimeConfig().mode).toBe('none');
    expect(resolveClaudeAuthState().mode).toBe('none');

    writeCredentialSettings('external', 'https://broker.local/anthropic');

    expect(getCredentialBrokerRuntimeConfig()).toMatchObject({
      mode: 'external',
      externalBrokerBaseUrl: 'https://broker.local/anthropic',
    });
    expect(resolveClaudeAuthState().mode).toBe('broker');
  });

  it('does not silently fall back when settings.yaml is malformed', async () => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-config-'));
    fs.writeFileSync(path.join(runtimeRoot, 'settings.yaml'), 'not: [yaml');
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.resetModules();

    await expect(import('@core/config/index.js')).rejects.toThrow(
      /Invalid runtime storage settings|settings file is invalid|expected/i,
    );
  });

  it('uses runtime .env before ambient env for channel credential getters', async () => {
    createRuntimeHome('onecli');
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      [
        'TELEGRAM_BOT_TOKEN=file-telegram-token',
        'SLACK_BOT_TOKEN=file-slack-bot-token',
        'SLACK_APP_TOKEN=file-slack-app-token',
        '',
      ].join('\n'),
      'utf-8',
    );
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'ambient-telegram-token');
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-slack-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'ambient-slack-app-token');
    vi.resetModules();

    const { getTelegramBotToken, getSlackBotToken, getSlackAppToken } =
      await import('@core/config/index.js');

    expect(getTelegramBotToken()).toBe('file-telegram-token');
    expect(getSlackBotToken()).toBe('file-slack-bot-token');
    expect(getSlackAppToken()).toBe('file-slack-app-token');
  });

  it('uses settings for default model and runtime .env before ambient env for storage URL', async () => {
    createRuntimeHome('onecli');
    const settingsPath = path.join(runtimeRoot, 'settings.yaml');
    fs.writeFileSync(
      settingsPath,
      fs
        .readFileSync(settingsPath, 'utf-8')
        .replace(
          'agent:\n  default_model: ""',
          'agent:\n  default_model: sonnet',
        ),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      [
        'MYCLAW_DATABASE_URL=postgres://file:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
      'utf-8',
    );
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-ambient-model');
    vi.stubEnv(
      'MYCLAW_DATABASE_URL',
      'postgres://ambient:pass@localhost:15432/myclaw',
    );
    vi.resetModules();

    const { getConfiguredDefaultModel, STORAGE_POSTGRES_URL } =
      await import('@core/config/index.js');

    expect(getConfiguredDefaultModel()).toBe('sonnet');
    expect(STORAGE_POSTGRES_URL).toBe(
      'postgres://file:pass@localhost:15432/myclaw',
    );
  });

  it('updates public runtime settings and persists typed changes', async () => {
    createRuntimeHome('onecli');
    vi.resetModules();

    const { getPublicRuntimeSettings, updatePublicRuntimeSettings } =
      await import('@core/config/index.js');

    expect(getPublicRuntimeSettings()).toMatchObject({
      agent: { name: 'Main Agent', defaultModel: '' },
      memory: { enabled: true, dreaming: { enabled: false } },
    });

    const result = updatePublicRuntimeSettings({
      agent: { name: '  Kai  ', defaultModel: ' sonnet ' },
      memory: { dreaming: { enabled: true } },
    });

    expect(result).toMatchObject({
      settings: {
        agent: { name: 'Kai', defaultModel: 'sonnet' },
        memory: { enabled: true, dreaming: { enabled: true } },
      },
      changed: ['agent.name', 'agent.defaultModel', 'memory.dreaming.enabled'],
      restartRequired: true,
    });

    const raw = fs.readFileSync(
      path.join(runtimeRoot, 'settings.yaml'),
      'utf-8',
    );
    expect(raw).toContain('name: Kai');
    expect(raw).toContain('default_model: sonnet');
    expect(raw).toContain('enabled: false');
  });

  it('rejects raw or unknown model values in public runtime settings', async () => {
    createRuntimeHome('onecli');
    vi.resetModules();

    const { updatePublicRuntimeSettings } =
      await import('@core/config/index.js');

    expect(() =>
      updatePublicRuntimeSettings({
        agent: { defaultModel: 'claude-sonnet-4-6' },
      }),
    ).toThrow(/Provider model ID "claude-sonnet-4-6" is not accepted/);
    expect(() =>
      updatePublicRuntimeSettings({
        agent: { oneTimeJobDefaultModel: 'sonet' },
      }),
    ).toThrow(/Did you mean "sonnet"/);
  });

  it('returns no-op metadata when a typed settings patch is unchanged', async () => {
    createRuntimeHome('onecli');
    vi.resetModules();

    const { updatePublicRuntimeSettings } =
      await import('@core/config/index.js');
    const result = updatePublicRuntimeSettings({
      agent: { name: 'Main Agent', defaultModel: '' },
      memory: { enabled: true, dreaming: { enabled: false } },
    });

    expect(result.changed).toEqual([]);
    expect(result.restartRequired).toBe(false);
  });
});
