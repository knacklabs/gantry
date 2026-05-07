import { afterEach, describe, expect, it, vi } from 'vitest';

import { runConfigCommand } from '@core/cli/config.js';
import { readEnvFile } from '@core/config/env/file.js';
import { validateRuntimeHomeEnvPolicy } from '@core/config/source-classification.js';
import { createRuntimeHomeFixture } from '../harness/runtime-home-fixture.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config credential boundary integration', () => {
  it('blocks wrong-lane writes and reports runtime env policy violations', () => {
    const fixture = createRuntimeHomeFixture({
      prefix: 'myclaw-config-boundary-',
    });

    expect(
      runConfigCommand(fixture.runtimeHome, [
        'set',
        'OPENAI_API_KEY',
        'sk-123',
      ]),
    ).toBe(1);
    expect(
      runConfigCommand(fixture.runtimeHome, [
        'set',
        'ONECLI_URL',
        'https://broker.example.com',
      ]),
    ).toBe(1);
    expect(
      runConfigCommand(fixture.runtimeHome, [
        'set',
        'MYCLAW_DATABASE_URL',
        'postgres://myclaw:pass@localhost:15432/myclaw',
      ]),
    ).toBe(0);

    fixture.writeEnv({
      OPENAI_API_KEY: 'sk-manual',
      ONECLI_URL: 'https://broker.manual.example.com',
      ANTHROPIC_BASE_URL: 'https://broker.manual.example.com',
      TELEGRAM_BOT_TOKEN: 'telegram-allowed',
    });

    const policy = validateRuntimeHomeEnvPolicy(fixture.runtimeHome);
    expect(policy.ok).toBe(false);
    expect(
      policy.violations.map((violation) => ({
        key: violation.key,
        lane: violation.lane,
      })),
    ).toEqual(
      expect.arrayContaining([
        { key: 'OPENAI_API_KEY', lane: 'agent-credential' },
        { key: 'ONECLI_URL', lane: 'non-secret-setting' },
        { key: 'ANTHROPIC_BASE_URL', lane: 'non-secret-setting' },
      ]),
    );
    expect(
      policy.violations.some(
        (violation) => violation.key === 'TELEGRAM_BOT_TOKEN',
      ),
    ).toBe(false);

    fixture.cleanup();
  });

  it('uses process env values for runtime secrets and ignores ambient raw provider credentials', async () => {
    const fixture = createRuntimeHomeFixture({
      prefix: 'myclaw-config-boundary-',
      mutateSettings(settings) {
        settings.credentialBroker.mode = 'external';
        settings.credentialBroker.onecli.url = '';
        settings.credentialBroker.external.baseUrl = '';
      },
    });
    fixture.writeEnv({
      MYCLAW_DATABASE_URL: 'postgres://file:pass@localhost:15432/myclaw',
      TELEGRAM_BOT_TOKEN: 'runtime-telegram-token',
    });

    vi.stubEnv('MYCLAW_HOME', fixture.runtimeHome);
    vi.stubEnv(
      'MYCLAW_DATABASE_URL',
      'postgres://ambient:pass@localhost:15432/ambient',
    );
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'ambient-telegram-token');
    vi.stubEnv('OPENAI_API_KEY', 'sk-ambient-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ambient-anthropic');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-ambient-token');
    vi.resetModules();

    const {
      STORAGE_POSTGRES_URL,
      getTelegramBotToken,
      resolveClaudeAuthState,
    } = await import('@core/config/index.js');

    expect(STORAGE_POSTGRES_URL).toBe(
      'postgres://ambient:pass@localhost:15432/ambient',
    );
    expect(getTelegramBotToken()).toBe('ambient-telegram-token');
    expect(resolveClaudeAuthState()).toMatchObject({
      hasApiKey: false,
      hasOauthToken: false,
      mode: 'none',
    });

    const policy = validateRuntimeHomeEnvPolicy(fixture.runtimeHome);
    expect(policy.ok).toBe(true);
    expect(readEnvFile(fixture.envPath)).toEqual(
      expect.objectContaining({
        MYCLAW_DATABASE_URL: 'postgres://file:pass@localhost:15432/myclaw',
        TELEGRAM_BOT_TOKEN: 'runtime-telegram-token',
      }),
    );

    fixture.cleanup();
  });
});
